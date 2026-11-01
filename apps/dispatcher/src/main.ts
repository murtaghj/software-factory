// Dispatcher process entry point. Configuration comes from the environment:
//   FACTORY_DATABASE_URL (runtime login), TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, FACTORY_TASK_QUEUE.
import { Connection } from '@temporalio/client';
import { Database } from '@factory/database';
import { ClientGateway } from './temporal.ts';
import { Dispatcher } from './dispatcher.ts';

const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const db = Database.connect(required('FACTORY_DATABASE_URL'));
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:57233' });
const dispatcher = new Dispatcher({ db, temporal: new ClientGateway(connection, process.env.TEMPORAL_NAMESPACE ?? 'factory'), taskQueue: process.env.FACTORY_TASK_QUEUE ?? 'factory-tasks' });
const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { controller.abort(); });
await dispatcher.runLoop(controller.signal, 1000, (e) => { console.error('dispatch pass failed', e); });
await connection.close();
await db.close();
