import type { Db } from "./db.js";
import { openStateDb, withTransaction } from "./db.js";
import { migrate } from "./migrate.js";
import { TriggerRepo } from "./repos/triggers.js";
import { InboxRepo } from "./repos/inbox.js";
import { TaskRepo } from "./repos/tasks.js";
import { SessionRepo, RunRepo } from "./repos/sessions.js";
import { OperationRepo } from "./repos/operations.js";
import { DeliveryRepo } from "./repos/deliveries.js";
import { CatalogRepo } from "./repos/catalog.js";
import { ToolActionRepo } from "./repos/tool-actions.js";
import { ThreadRepo } from "./repos/threads.js";

export {
  openStateDb,
  withTransaction,
  migrate,
  type Db,
};

export class Store {
  readonly triggers: TriggerRepo;
  readonly inbox: InboxRepo;
  readonly tasks: TaskRepo;
  readonly sessions: SessionRepo;
  readonly runs: RunRepo;
  readonly operations: OperationRepo;
  readonly deliveries: DeliveryRepo;
  readonly catalog: CatalogRepo;
  readonly toolActions: ToolActionRepo;
  readonly threads: ThreadRepo;

  constructor(readonly db: Db) {
    this.triggers = new TriggerRepo(db);
    this.inbox = new InboxRepo(db);
    this.tasks = new TaskRepo(db);
    this.sessions = new SessionRepo(db);
    this.runs = new RunRepo(db);
    this.operations = new OperationRepo(db);
    this.deliveries = new DeliveryRepo(db);
    this.catalog = new CatalogRepo(db);
    this.toolActions = new ToolActionRepo(db);
    this.threads = new ThreadRepo(db);
  }

  static open(dbPath: string): Store {
    const db = openStateDb(dbPath);
    migrate(db);
    return new Store(db);
  }

  transaction<T>(fn: () => T): T {
    return withTransaction(this.db, fn);
  }

  close(): void {
    this.db.close();
  }
}
