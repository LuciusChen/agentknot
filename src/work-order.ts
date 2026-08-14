import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { assertTextLimit, MAX_PROMPT_BYTES } from './record-limits.js';

export const WORK_ORDER_STATUSES = ['issued'] as const;

export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export interface WorkOrderCommand {
  /** The outcome requested by the upstream user or controller. */
  objective: string;
  /** The canonical workspace in which later execution may occur. */
  workspace: string;
  acceptanceCriteria: string[];
  constraints: string[];
  /** Opaque source revision selected by the issuer, if one is required. */
  baseRevision?: string;
}

export type WorkOrderEventType = 'work-order.issued';

export interface WorkOrderEvent {
  sequence: number;
  workOrderId: string;
  at: string;
  type: WorkOrderEventType;
}

export interface WorkOrderRecord {
  id: string;
  schemaVersion: 1;
  status: WorkOrderStatus;
  /** Immutable after issue; persistence exposes no general WorkOrder update operation. */
  command: WorkOrderCommand;
  createdAt: string;
  updatedAt: string;
  events: WorkOrderEvent[];
}

export interface WorkOrderStore {
  create(record: WorkOrderRecord): Promise<void>;
  get(id: string): Promise<WorkOrderRecord | undefined>;
  list(): Promise<WorkOrderRecord[]>;
  eventsAfter(id: string, sequence: number): Promise<WorkOrderEvent[]>;
}

export interface WorkOrderServiceOptions {
  store: WorkOrderStore;
  now?: () => Date;
}

function assertNonEmptyText(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  assertTextLimit(label, value, MAX_PROMPT_BYTES);
}

function normalizeTextList(label: string, value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    assertNonEmptyText(`${label}[${index}]`, entry);
    return entry;
  });
}

function normalizeWorkOrderCommand(command: WorkOrderCommand): WorkOrderCommand {
  if (typeof command !== 'object' || command === null || Array.isArray(command)) {
    throw new Error('WorkOrder command must be an object');
  }
  assertNonEmptyText('WorkOrder objective', command.objective);
  assertNonEmptyText('WorkOrder workspace', command.workspace);
  const acceptanceCriteria = normalizeTextList(
    'WorkOrder acceptanceCriteria',
    command.acceptanceCriteria
  );
  const constraints = normalizeTextList('WorkOrder constraints', command.constraints);
  if (command.baseRevision !== undefined) {
    assertNonEmptyText('WorkOrder baseRevision', command.baseRevision);
  }
  return {
    objective: command.objective,
    workspace: path.resolve(command.workspace),
    acceptanceCriteria,
    constraints,
    ...(command.baseRevision === undefined ? {} : { baseRevision: command.baseRevision }),
  };
}

/** Domain service for issuing immutable command roots. It does not launch execution. */
export class WorkOrderService {
  readonly #store: WorkOrderStore;
  readonly #now: () => Date;

  constructor(options: WorkOrderServiceOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  async issue(command: WorkOrderCommand): Promise<WorkOrderRecord> {
    const normalized = normalizeWorkOrderCommand(command);
    const id = `work_order_${randomUUID()}`;
    const now = this.#now().toISOString();
    const record: WorkOrderRecord = {
      id,
      schemaVersion: 1,
      status: 'issued',
      command: normalized,
      createdAt: now,
      updatedAt: now,
      events: [
        {
          sequence: 1,
          workOrderId: id,
          at: now,
          type: 'work-order.issued',
        },
      ],
    };
    await this.#store.create(record);
    return structuredClone(record);
  }

  get(id: string): Promise<WorkOrderRecord | undefined> {
    return this.#store.get(id);
  }

  list(): Promise<WorkOrderRecord[]> {
    return this.#store.list();
  }

  eventsAfter(id: string, sequence: number): Promise<WorkOrderEvent[]> {
    return this.#store.eventsAfter(id, sequence);
  }
}
