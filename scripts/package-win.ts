/**
 * Builds the Windows installer (ADR-0029).
 *
 *   npm run package:win              builds everything, stages the application and writes release\CommerceBill-Setup-<version>.exe
 *   npm run package:win -- --dir     only the unpacked application (release\win-unpacked), no installer
 *   npm run package:win -- --skip-build    reuse the existing build output
 *
 * The application is staged OUTSIDE the repository (in the system temp folder) so the packager sees exactly the files listed here and
 * nothing from the monorepo. What ships: the Electron shell (main and preload only, in app.asar), the web screens, the local service
 * bundled into ONE file, the migrations, the private PostgreSQL programs, and the one native module the service needs. No source maps, no
 * test code, no .env, no database, no backup, no developer tools.
 *
 * Signing: if a code-signing certificate is provided to the packager (WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD, or CSC_LINK / CSC_KEY_PASSWORD) the
 * installer and the application are signed. Without one the build is an UNSIGNED development build and says so. No certificate is ever
 * generated or faked here.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build as esbuild } from 'esbuild';
import { Platform, build } from 'electron-builder';

const repo = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const dirOnly = args.has('--dir');
// --e2e adds the marker that lets an installed build run the end-to-end driver. NEVER used for the release installer.
const e2eVariant = args.has('--e2e');
const outIdx = process.argv.indexOf('--out');
const skipBuild = args.has('--skip-build');
const desktopPkg = JSON.parse(
  readFileSync(join(repo, 'apps', 'desktop', 'package.json'), 'utf8'),
) as { version: string };
const version = desktopPkg.version;
const releaseDir = outIdx > 0 ? resolve(process.argv[outIdx + 1]!) : join(repo, 'release');
const tag = e2eVariant ? '-e2e' : '';
const stage = join(tmpdir(), `commercebill-stage${tag}`);
const extra = join(tmpdir(), `commercebill-stage-extra${tag}`);
const say = (m: string) => process.stdout.write(`[package:win] ${m}\n`);

function run(cmd: string, a: string[]): void {
  execFileSync(cmd, a, { cwd: repo, stdio: 'inherit', shell: true });
}

if (process.platform !== 'win32') throw new Error('The Windows installer is built on Windows.');
if (!skipBuild) {
  say('building the application (api, web, desktop)');
  run('npm', ['run', 'build']);
}
for (const f of [
  'apps/desktop/dist/main.cjs',
  'apps/desktop/dist/preload.cjs',
  'apps/web/dist/index.html',
  'apps/api/dist/main.js',
])
  if (!existsSync(join(repo, f)))
    throw new Error(`Missing build output ${f}: run without --skip-build.`);

rmSync(stage, { recursive: true, force: true });
rmSync(extra, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(extra, { recursive: true });

// 1. the Electron shell
cpSync(join(repo, 'apps/desktop/dist/main.cjs'), join(stage, 'main.cjs'));
cpSync(join(repo, 'apps/desktop/dist/preload.cjs'), join(stage, 'preload.cjs'));
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'commercebill-desktop',
      productName: 'CommerceBill',
      version,
      description:
        'CommerceBill Desktop: local billing, inventory and receivables for one business computer',
      main: 'main.cjs',
      author: 'CommerceBill',
    },
    null,
    2,
  ),
);

// 2. the web screens (no source maps)
cpSync(join(repo, 'apps/web/dist'), join(extra, 'web'), {
  recursive: true,
  filter: (p) => !p.endsWith('.map'),
});

// 3. the local service, bundled into one file; only the native password-hashing module stays outside
say('bundling the local service');
mkdirSync(join(extra, 'api'), { recursive: true });
await esbuild({
  entryPoints: [join(repo, 'apps/api/src/main.ts')],
  outfile: join(extra, 'api', 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // the native password-hashing module is shipped beside the bundle (api/vendor/argon2) and imported by relative path
  alias: { '@node-rs/argon2': './vendor/argon2/index.js' },
  external: ['./vendor/argon2/index.js', 'pg-native'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'warning',
});
// (a folder named node_modules is skipped by the packager, so the module lives in api/vendor)
const argon2Out = join(extra, 'api', 'vendor', 'argon2');
mkdirSync(argon2Out, { recursive: true });
for (const f of ['index.js', 'package.json', 'LICENSE'])
  cpSync(join(repo, 'node_modules/@node-rs/argon2', f), join(argon2Out, f));
cpSync(
  join(repo, 'node_modules/@node-rs/argon2-win32-x64-msvc/argon2.win32-x64-msvc.node'),
  join(argon2Out, 'argon2.win32-x64-msvc.node'),
);

// 4. the migrations (SQL only)
for (const n of readdirSync(join(repo, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d))) {
  mkdirSync(join(extra, 'migrations', n), { recursive: true });
  cpSync(
    join(repo, 'prisma/migrations', n, 'migration.sql'),
    join(extra, 'migrations', n, 'migration.sql'),
  );
}

// 5. the private PostgreSQL programs, plus the Visual C++ runtime they need, shipped with them (app-local, no installer prerequisite)
say('staging PostgreSQL');
const pgNative = join(repo, 'node_modules/@embedded-postgres/windows-x64/native');
const pgOut = join(extra, 'postgres');
const SKIP = /^(wx.*\.dll|testplug\.dll)$/i;
cpSync(join(pgNative, 'bin'), join(pgOut, 'bin'), {
  recursive: true,
  filter: (p) => !SKIP.test(p.split(/[\\/]/).pop()!),
});
cpSync(join(pgNative, 'lib'), join(pgOut, 'lib'), { recursive: true });
cpSync(join(pgNative, 'share'), join(pgOut, 'share'), { recursive: true });
for (const dll of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
  const src = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', dll);
  if (!existsSync(src))
    throw new Error(
      `${dll} is not on this build computer: install the Microsoft Visual C++ Redistributable (x64) here, then rebuild.`,
    );
  cpSync(src, join(pgOut, 'bin', dll));
}

// 6. notices
mkdirSync(join(extra, 'licenses'), { recursive: true });
cpSync(
  join(repo, 'apps/desktop/build/THIRD_PARTY_NOTICES.txt'),
  join(extra, 'licenses', 'THIRD_PARTY_NOTICES.txt'),
);

if (e2eVariant)
  writeFileSync(
    join(extra, 'e2e-enabled'),
    'test build only: lets an installed build run the end-to-end driver',
  );

const signing = Boolean(process.env.WIN_CSC_LINK || process.env.CSC_LINK);
say(
  signing
    ? 'a code-signing certificate was provided: the build will be signed'
    : 'no code-signing certificate: this is an UNSIGNED development build',
);

say(dirOnly ? 'packaging the unpacked application' : 'building the installer');
rmSync(releaseDir, { recursive: true, force: true });
const variantNote = e2eVariant ? ' (END-TO-END TEST VARIANT: not for release)' : '';
say(`output: ${releaseDir}${variantNote}`);
await build({
  targets: Platform.WINDOWS.createTarget(dirOnly ? 'dir' : 'nsis', 1 /* x64 */),
  publish: 'never',
  config: {
    appId: 'com.commercebill.desktop',
    productName: 'CommerceBill',
    copyright: 'CommerceBill',
    directories: {
      app: stage,
      output: releaseDir,
      buildResources: join(repo, 'apps/desktop/build'),
    },
    electronVersion: (
      JSON.parse(readFileSync(join(repo, 'node_modules/electron/package.json'), 'utf8')) as {
        version: string;
      }
    ).version,
    electronDist: join(repo, 'node_modules/electron/dist'),
    electronLanguages: ['en-US'],
    asar: true,
    files: ['main.cjs', 'preload.cjs', 'package.json'],
    extraResources: [
      { from: join(extra, 'web'), to: 'web' },
      { from: join(extra, 'api'), to: 'api' },
      { from: join(extra, 'migrations'), to: 'migrations' },
      { from: join(extra, 'postgres'), to: 'postgres' },
      { from: join(extra, 'licenses'), to: 'licenses' },
      ...(e2eVariant ? [{ from: join(extra, 'e2e-enabled'), to: 'e2e-enabled' }] : []),
    ],
    // No developer tools or debugging switches in the installed application.
    // RunAsNode stays on: the local service runs on the same executable (ELECTRON_RUN_AS_NODE). The debugging switches are off.
    electronFuses: {
      runAsNode: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      onlyLoadAppFromAsar: true,
    },
    win: {
      target: [{ target: dirOnly ? 'dir' : 'nsis', arch: ['x64'] }],
      icon: join(repo, 'apps/desktop/build/icon.ico'),
      legalTrademarks: 'CommerceBill',
      requestedExecutionLevel: 'asInvoker',
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'CommerceBill',
      uninstallDisplayName: 'CommerceBill',
      deleteAppDataOnUninstall: false,
      runAfterFinish: true,
      installerIcon: join(repo, 'apps/desktop/build/icon.ico'),
      uninstallerIcon: join(repo, 'apps/desktop/build/icon.ico'),
      artifactName: 'CommerceBill-Setup-${version}.exe',
      include: join(repo, 'apps/desktop/build/installer.nsh'),
    },
  },
});

// installer record: name, version, size, checksum, signed or not
const files = readdirSync(releaseDir);
const exe = files.find((f) => /^CommerceBill-Setup-.*\.exe$/.test(f));
const info = {
  builtAt: new Date().toISOString(),
  version,
  signed: signing,
  kind: dirOnly ? 'unpacked directory' : 'NSIS installer (per-user, no elevation)',
  installer: exe ?? null,
  sizeBytes: exe ? statSync(join(releaseDir, exe)).size : null,
  sha256: exe
    ? createHash('sha256')
        .update(readFileSync(join(releaseDir, exe)))
        .digest('hex')
    : null,
  buildCommand: 'npm run package:win',
  builtOn: `Windows ${process.getSystemVersion?.() ?? ''} (${process.arch})`,
};
writeFileSync(join(releaseDir, 'installer-info.json'), JSON.stringify(info, null, 2));
say(JSON.stringify(info));
