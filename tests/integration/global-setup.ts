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
  await cluster?.stop();
}
