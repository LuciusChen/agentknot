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

interface WorkOrderEventBase {
  sequence: number;
  workOrderId: string;
  at: string;
}

export interface WorkOrderIssuedEvent extends WorkOrderEventBase {
  type: 'work-order.issued';
}

export interface WorkOrderExecutorJobBoundEvent extends WorkOrderEventBase {
  type: 'work-order.executor-job.bound';
  data: { executorJobId: string };
}

export type WorkOrderEvent = WorkOrderIssuedEvent | WorkOrderExecutorJobBoundEvent;

export type WorkOrderEventType = WorkOrderEvent['type'];

export interface WorkOrderRecord {
  id: string;
  schemaVersion: 1;
  status: WorkOrderStatus;
  /** Immutable after issue; persistence exposes no general WorkOrder update operation. */
  command: WorkOrderCommand;
  /** The one already-admitted Job explicitly selected for execution of this command. */
  executorJobId?: string;
  createdAt: string;
  updatedAt: string;
  events: WorkOrderEvent[];
}

export interface WorkOrderStore {
  create(record: WorkOrderRecord): Promise<void>;
  get(id: string): Promise<WorkOrderRecord | undefined>;
  list(): Promise<WorkOrderRecord[]>;
  eventsAfter(id: string, sequence: number): Promise<WorkOrderEvent[]>;
  bindExecutorJob(
    workOrderId: string,
    expectedWorkOrderRevision: number,
    executorJobId: string,
    at: string
  ): Promise<WorkOrderRecord>;
}

export interface WorkOrderServiceOptions {
  store: WorkOrderStore;
  now?: () => Date;
}

export class WorkOrderBindingConflictError extends Error {
  readonly name = 'WorkOrderBindingConflictError';
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

  /** Binds one already-persisted Job; it neither creates nor starts execution. */
  async bindExecutorJob(
    workOrderId: string,
    expectedWorkOrderRevision: number,
    executorJobId: string
  ): Promise<WorkOrderRecord> {
    const workOrder = await this.#store.get(workOrderId);
    if (workOrder === undefined) throw new Error(`WorkOrder ${workOrderId} does not exist`);
    if (workOrder.status !== 'issued') {
      throw new Error(`WorkOrder ${workOrderId} must be issued before binding an executor Job`);
    }
    if (
      workOrder.executorJobId !== undefined &&
      workOrder.executorJobId !== executorJobId
    ) {
      throw new WorkOrderBindingConflictError(
        `WorkOrder ${workOrderId} is already bound to executor Job ${workOrder.executorJobId}`
      );
    }
    return this.#store.bindExecutorJob(
      workOrderId,
      expectedWorkOrderRevision,
      executorJobId,
      this.#now().toISOString()
    );
  }
}
