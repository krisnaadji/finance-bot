import type { Fixture } from './phase2Db';
import { applyPhase3MigrationsThrough } from './phase2Db';
import { seedCategoryFixture } from '../categoryFixture';

// phase2Db owns the unchanged loopback/disposable-name guard and schema lifecycle.
export { applyPhase3MigrationsThrough, closeFixture, sql, sqlAs } from './phase2Db';
export async function initializePhase3Fixture(): Promise<void> {
  await applyPhase3MigrationsThrough();
}
export async function seedPhase3LinkedFixture(): Promise<Fixture> {
  const f = await seedCategoryFixture();
  return { accountId:f.accountId, ownerId:f.ownerId, memberId:f.memberId,
    categoryId:f.parentId, chatId:f.chatId, requester:f.requester };
}
