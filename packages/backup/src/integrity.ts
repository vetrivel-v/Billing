/**
 * Critical business-integrity checks run against the ISOLATED restored database (never the live one). The load skips the triggers
 * and constraints that normally enforce these rules, so each rule is re-checked here, set-based, from the restored data itself.
 * Every check yields only a name, pass/fail and a count: never row data.
 */
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { exportSnapshot, currentSchemaVersion, quoteIdent, withClient } from './dump.js';
import type { BackupManifest } from './manifest.js';
import { batches, PROJECTION_TABLE } from './restore.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CheckResult {
  name: string;
  ok: boolean;
  /** A count or a short fixed phrase: never data. */
  detail?: string;
}

export interface IntegrityContext {
  manifest: BackupManifest;
  /** The newest migration this application knows. */
  expectedSchemaVersion: string;
  /** The migration SQL texts, to derive the protective triggers that must exist. */
  migrationSql: string[];
  /** The NDJSON file of the projection the backup carried (compared with the rebuilt one). */
  dumpedBalancesFile?: string | undefined;
}

/** Triggers created by the migrations and not dropped later (name + table): the expected protective set. */
export function expectedTriggers(migrationSql: string[]): { name: string; table: string }[] {
  const live = new Map<string, { name: string; table: string }>();
  for (const sql of migrationSql) {
    for (const m of sql.matchAll(
      /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"([^"]+)"[\s\S]*?\sON\s+"([^"]+)"/g,
    ))
      live.set(`${m[2]}.${m[1]}`, { name: m[1]!, table: m[2]! });
    for (const m of sql.matchAll(
      /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?\s+ON\s+"?([A-Za-z0-9_]+)"?/g,
    ))
      live.delete(`${m[2]}.${m[1]}`);
  }
  return [...live.values()];
}

const count = async (c: pg.Client, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await c.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);

async function foreignKeyViolations(c: pg.Client): Promise<number> {
  const fks = await c.query<{
    child: string;
    parent: string;
    child_cols: string[];
    parent_cols: string[];
  }>(
    `SELECT cl.relname AS child, pl.relname AS parent,
            (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_cols,
            (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_cols
       FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_class pl ON pl.oid = c.confrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'`,
  );
  let bad = 0;
  for (const fk of fks.rows) {
    const notNull = fk.child_cols.map((x) => `ch.${quoteIdent(x)} IS NOT NULL`).join(' AND ');
    const match = fk.child_cols
      .map((x, i) => `p.${quoteIdent(fk.parent_cols[i]!)} = ch.${quoteIdent(x)}`)
      .join(' AND ');
    bad += await count(
      c,
      `SELECT count(*)::text AS n FROM ${quoteIdent(fk.child)} ch WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${quoteIdent(fk.parent)} p WHERE ${match})`,
    );
  }
  return bad;
}

async function compareProjection(c: pg.Client, file: string): Promise<number> {
  await c.query(`CREATE TEMP TABLE cb_dumped_balances (LIKE ${quoteIdent(PROJECTION_TABLE)})`);
  for await (const lines of batches(file))
    await c.query(
      `INSERT INTO cb_dumped_balances SELECT * FROM json_populate_recordset(null::cb_dumped_balances, $1::json)`,
      [`[${lines.join(',')}]`],
    );
  return count(
    c,
    `SELECT count(*)::text AS n FROM (
       (SELECT "warehouse_id", "product_id", "quantity_on_hand" FROM "stock_balances" EXCEPT SELECT "warehouse_id", "product_id", "quantity_on_hand" FROM cb_dumped_balances)
       UNION ALL
       (SELECT "warehouse_id", "product_id", "quantity_on_hand" FROM cb_dumped_balances EXCEPT SELECT "warehouse_id", "product_id", "quantity_on_hand" FROM "stock_balances")) d`,
  );
}

/** Runs every critical check and returns all results (it does not stop at the first failure). */
export async function runIntegrityChecks(
  url: string,
  ctx: IntegrityContext,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail?: string) =>
    results.push({ name, ok, ...(detail !== undefined ? { detail } : {}) });
  const zero = async (c: pg.Client, name: string, sql: string, params: unknown[] = []) => {
    const n = await count(c, sql, params);
    add(name, n === 0, n === 0 ? 'none' : `${n} violation(s)`);
  };
  await withClient(url, async (c) => {
    await c.query('BEGIN');
    try {
      const orgId = ctx.manifest.organization.id;
      const version = await currentSchemaVersion(c);
      add(
        'schema_version',
        version === ctx.manifest.schemaVersion && version === ctx.expectedSchemaVersion,
        version === ctx.manifest.schemaVersion ? 'matches' : 'differs',
      );
      add(
        'organization_present',
        (await count(c, `SELECT count(*)::text AS n FROM organizations WHERE id = $1`, [orgId])) ===
          1,
      );
      add(
        'administrator_present',
        (await count(
          c,
          `SELECT count(*)::text AS n FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.organization_id = $1 AND u.is_active AND r.name = 'Administrator'`,
          [orgId],
        )) >= 1,
      );
      add(
        'permissions_present',
        (await count(c, `SELECT count(*)::text AS n FROM permissions`)) > 0 &&
          (await count(c, `SELECT count(*)::text AS n FROM role_permissions`)) > 0,
      );
      const fk = await foreignKeyViolations(c);
      add('foreign_keys', fk === 0, fk === 0 ? 'none' : `${fk} orphan row(s)`);
      await zero(
        c,
        'product_references',
        `SELECT count(*)::text AS n FROM products p LEFT JOIN units u ON u.id = p.unit_id LEFT JOIN tax_categories t ON t.id = p.tax_category_id LEFT JOIN hsn_sac_codes h ON h.id = p.hsn_sac_code_id
        WHERE (u.id IS NOT NULL AND u.organization_id <> p.organization_id) OR t.organization_id <> p.organization_id OR (h.id IS NOT NULL AND h.organization_id <> p.organization_id)`,
      );

      const have = new Set(
        (
          await c.query<{ k: string }>(
            `SELECT cl.relname || '.' || t.tgname AS k FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid JOIN pg_namespace n ON n.oid = cl.relnamespace WHERE NOT t.tgisinternal AND t.tgenabled IN ('O', 'A') AND n.nspname = 'public'`,
          )
        ).rows.map((r) => r.k),
      );
      const missing = expectedTriggers(ctx.migrationSql).filter(
        (t) => !have.has(`${t.table}.${t.name}`),
      );
      add(
        'protective_triggers_present',
        missing.length === 0,
        missing.length === 0 ? 'all present and enabled' : `${missing.length} missing`,
      );

      await zero(
        c,
        'stock_balance_reconciles_to_ledger',
        `SELECT count(*)::text AS n FROM
        (SELECT "warehouse_id", "product_id", sum("quantity_delta") AS s FROM "stock_movements" GROUP BY 1, 2) m
        FULL JOIN "stock_balances" b USING ("warehouse_id", "product_id") WHERE COALESCE(m.s, 0) <> COALESCE(b."quantity_on_hand", 0)`,
      );
      if (ctx.dumpedBalancesFile) {
        const diff = await compareProjection(c, ctx.dumpedBalancesFile);
        add(
          'stock_projection_matches_backup',
          diff === 0,
          diff === 0 ? 'identical' : `${diff} differing row(s)`,
        );
      }

      add(
        'tax_configuration_present',
        (await count(
          c,
          `SELECT count(*)::text AS n FROM tax_categories WHERE organization_id = $1`,
          [orgId],
        )) > 0 &&
          (await count(c, `SELECT count(*)::text AS n FROM tax_rates WHERE organization_id = $1`, [
            orgId,
          ])) > 0,
      );
      await zero(
        c,
        'tax_review_integrity',
        `SELECT count(*)::text AS n FROM (
        SELECT 1 FROM tax_configuration_reviews r WHERE r.fingerprint !~ '^[0-9a-f]{64}$'
        UNION ALL SELECT 1 FROM sales_invoices i LEFT JOIN tax_configuration_reviews r ON r.id = i.tax_review_id WHERE NOT i.is_demo AND (r.id IS NULL OR r.organization_id <> i.organization_id)) x`,
      );

      await zero(
        c,
        'document_sequences_consistent',
        `SELECT count(*)::text AS n FROM document_sequences s WHERE s.last_number <> COALESCE((SELECT max(a.sequence_number) FROM document_number_allocations a WHERE a.sequence_id = s.id), 0)`,
      );
      await zero(
        c,
        'invoice_numbers_issued_by_ledger',
        `SELECT count(*)::text AS n FROM sales_invoices i WHERE NOT EXISTS (
        SELECT 1 FROM document_number_allocations a JOIN document_sequences s ON s.id = a.sequence_id
         WHERE a.organization_id = i.organization_id AND a.document_type = i.document_type AND a.document_ref = i.id::text AND a.formatted_number = i.document_number AND s.financial_year_id = i.financial_year_id)`,
      );
      await zero(
        c,
        'payment_numbers_issued_by_ledger',
        `SELECT count(*)::text AS n FROM payments p WHERE NOT EXISTS (
        SELECT 1 FROM document_number_allocations a JOIN document_sequences s ON s.id = a.sequence_id
         WHERE a.organization_id = p.organization_id AND a.document_type = p.document_type AND a.document_ref = p.id::text AND a.formatted_number = p.payment_number AND s.financial_year_id = p.financial_year_id)`,
      );

      await zero(
        c,
        'invoice_totals_equal_lines',
        `SELECT count(*)::text AS n FROM sales_invoices i LEFT JOIN (
          SELECT invoice_id, count(*) AS n, sum(gross_amount) AS g, sum(discount_amount) AS d, sum(taxable_value) AS t, sum(cgst_amount) AS c, sum(sgst_amount) AS s,
                 sum(utgst_amount) AS u, sum(igst_amount) AS ig, sum(rounding_adjustment) AS a, sum(line_total) AS lt FROM sales_invoice_lines GROUP BY invoice_id) l ON l.invoice_id = i.id
        WHERE l.n IS NULL OR l.g <> i.gross_subtotal OR l.d <> i.line_discount_total OR l.t <> i.taxable_subtotal OR l.c <> i.cgst_total OR l.s <> i.sgst_total
           OR l.u <> i.utgst_total OR l.ig <> i.igst_total OR l.a <> i.rounding_adjustment_total OR l.lt + i.round_off <> i.grand_total`,
      );
      await zero(
        c,
        'invoice_dispatch_links',
        `SELECT count(*)::text AS n FROM (
        SELECT 1 FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id
         WHERE l.stock_effect = 'DISPATCH' AND (SELECT count(*) FROM stock_movements m WHERE m.organization_id = i.organization_id AND m.movement_type = 'SALES_DISPATCH'
              AND m.source_type = 'SALES_INVOICE' AND m.source_ref = i.id::text AND m.source_line_ref = l.id::text AND m.product_id = l.product_id
              AND m.warehouse_id = i.warehouse_id AND m.quantity_delta = -l.quantity AND m.business_date = i.invoice_date) <> 1
        UNION ALL SELECT 1 FROM sales_invoice_lines l WHERE l.stock_effect = 'NONE' AND EXISTS (SELECT 1 FROM stock_movements m WHERE m.movement_type = 'SALES_DISPATCH' AND m.source_line_ref = l.id::text)
        UNION ALL SELECT 1 FROM stock_movements m WHERE m.movement_type = 'SALES_DISPATCH' AND NOT EXISTS (
          SELECT 1 FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id WHERE l.id::text = m.source_line_ref AND i.id::text = m.source_ref AND l.stock_effect = 'DISPATCH' AND NOT i.is_demo)) x`,
      );

      await zero(
        c,
        'payments_fully_allocated',
        `SELECT count(*)::text AS n FROM payments p WHERE NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = p.id)
          OR p.amount <> (SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id)`,
      );
      await zero(
        c,
        'payment_allocation_links',
        `SELECT count(*)::text AS n FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN sales_invoices i ON i.id = a.invoice_id
        WHERE i.customer_id <> p.customer_id OR i.is_demo <> p.is_demo OR a.is_demo <> p.is_demo OR i.organization_id <> p.organization_id`,
      );
      await zero(
        c,
        'allocations_within_invoice_totals',
        `SELECT count(*)::text AS n FROM (SELECT i.id FROM sales_invoices i JOIN payment_allocations a ON a.invoice_id = i.id GROUP BY i.id, i.grand_total HAVING sum(a.amount) > i.grand_total) x`,
      );
      await zero(
        c,
        'demo_production_separation',
        `SELECT count(*)::text AS n FROM (
        SELECT 1 FROM sales_invoices i WHERE i.is_demo <> (i.document_type = 'DEMO_INVOICE')
        UNION ALL SELECT 1 FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id WHERE i.is_demo AND l.stock_effect <> 'NONE'
        UNION ALL SELECT 1 FROM payments p WHERE p.is_demo <> (p.document_type = 'DEMO_PAYMENT_RECEIPT')) x`,
      );
      add(
        'audit_history_present',
        (await count(c, `SELECT count(*)::text AS n FROM audit_logs`)) ===
          (ctx.manifest.tables.find((t) => t.name === 'audit_logs')?.rows ?? -1),
      );
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });

  // Content identity: every restored table, exported again the same way, must have exactly the checksum the backup recorded.
  const dir = await mkdtemp(join(tmpdir(), 'cb-verify-'));
  try {
    const again = await exportSnapshot(url, dir);
    const bad: string[] = [];
    for (const t of ctx.manifest.tables) {
      if (t.name === PROJECTION_TABLE) continue; // rebuilt, compared by value above
      const r = again.tables.find((x) => x.name === t.name);
      if (!r || r.rows !== t.rows || r.sha256 !== t.sha256) bad.push(t.name);
    }
    add(
      'restored_content_identical',
      bad.length === 0,
      bad.length === 0
        ? `${again.tables.length} tables identical`
        : `${bad.length} table(s) differ`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return results;
}

export const allPassed = (r: CheckResult[]): boolean => r.length > 0 && r.every((x) => x.ok);

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}
