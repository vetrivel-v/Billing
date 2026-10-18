import { startTestCluster, type TestCluster } from '@commercebill/test-utilities';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

let cluster: TestCluster | undefined;

/** Starts one throwaway PostgreSQL cluster for the whole integration run. */
export async function setup(project: TestProject): Promise<void> {
  cluster = await startTestCluster();
  project.provide('pgAdminUrl', cluster.adminUrl);
}

export async function teardown(): Promise<void> {
  // Observed on Windows (Task 1.1): after this teardown the process exited with code 0 even though tests
  // failed (process.exitCode was still 1 right after stop(); root cause not isolated - it is not rmSync and
  // not an empty globalSetup). That produced a false PASS from the integration gate. Re-assert the failing
  // exit code at process exit. verify-phase0 additionally cross-checks the JSON test report.
  const failedCode = process.exitCode;
  await cluster?.stop();
  if (failedCode) process.once('exit', () => (process.exitCode = failedCode));
}
