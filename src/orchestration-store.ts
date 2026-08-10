import RecordStoreBackend from './store.js';
import type { OrchestrationRecord, OrchestrationStore } from './orchestration-types.js';

export class MemoryOrchestrationStore
  extends RecordStoreBackend<OrchestrationRecord>
  implements OrchestrationStore
{
  constructor() {
    super('Orchestration');
  }
}

export class FileOrchestrationStore
  extends RecordStoreBackend<OrchestrationRecord>
  implements OrchestrationStore
{
  constructor(readonly directory: string) {
    super('Orchestration', directory);
  }
}
