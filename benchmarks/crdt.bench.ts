import {
  computeDiff,
  encodeDocumentState,
  initYjsDoc,
  materializeDocumentFromUpdate,
  materializeYjsDoc,
  mergeUpdate,
} from "@embedded/shared/yjs";
import { bench, describe } from "@tests/testkit";
import * as Y from "yjs";

import {
  closeTrackedResources,
  crdtSeedRow,
  crdtTaskDefinition,
  type CrdtSeedRow,
} from "./helpers";

const definition = crdtTaskDefinition();

function bufferFromUpdate(update: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(update.byteLength);
  new Uint8Array(buffer).set(update);
  return buffer;
}

function buildRemoteDiff(row: CrdtSeedRow): Uint8Array {
  const local = initYjsDoc(definition, row, 0, { skipProse: true });
  const localVector = Y.encodeStateVector(local);

  const remote = initYjsDoc(definition, row, 0, { skipProse: true });
  Y.applyUpdateV2(remote, Y.encodeStateAsUpdateV2(local));
  remote.transact(() => {
    const fields = remote.getMap("fields");
    const statusRegister = fields.get("status");
    if (statusRegister instanceof Y.Map) {
      statusRegister.set(`remote-${row._id}`, {
        value: "blocked",
        timestamp: 10,
      });
    }
    const counter = fields.get("votes");
    if (counter instanceof Y.Array) {
      counter.push([{ client: "remote", delta: 3, timestamp: 10 }]);
    }
    const tagSet = fields.get("tags");
    if (tagSet instanceof Y.Map) {
      tagSet.set(`remote-tag-${row._id}`, { addedBy: "remote", addedAt: 10 });
    }
  }, "remote");

  const diff = computeDiff(Y.encodeStateAsUpdateV2(remote), localVector);
  local.destroy();
  remote.destroy();
  return diff;
}

interface MergeBatch {
  readonly rows: CrdtSeedRow[];
  readonly diffs: Uint8Array[];
}

function buildMergeBatch(count: number): MergeBatch {
  const rows = Array.from({ length: count }, (_, index) => crdtSeedRow(index));
  const diffs = rows.map((row) => buildRemoteDiff(row));
  return { rows, diffs };
}

function mergeBatch(batch: MergeBatch): number {
  let merged = 0;
  for (let index = 0; index < batch.rows.length; index += 1) {
    const row = batch.rows[index];
    const diff = batch.diffs[index];
    if (!row || !diff) continue;
    const yjsDoc = initYjsDoc(definition, row, 0, { skipProse: true });
    Y.applyUpdateV2(yjsDoc, diff);
    const crdtFields = materializeYjsDoc(definition, yjsDoc);
    const result: Record<string, unknown> = { ...row, ...crdtFields };
    yjsDoc.destroy();
    merged += Object.keys(result).length;
  }
  return merged;
}

function buildEditHistory(edits: number): Uint8Array[] {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const updates: Uint8Array[] = [];
  let vector = Y.encodeStateVector(doc);
  for (let edit = 0; edit < edits; edit += 1) {
    text.insert(text.length, `edit-${edit} `);
    const full = Y.encodeStateAsUpdateV2(doc);
    updates.push(computeDiff(full, vector));
    vector = Y.encodeStateVector(doc);
  }
  doc.destroy();
  return updates;
}

const SMALL_BATCH = 200;
const MEDIUM_BATCH = 1_000;
const SMALL_BATCH_DATA = buildMergeBatch(SMALL_BATCH);
const MEDIUM_BATCH_DATA = buildMergeBatch(MEDIUM_BATCH);

let manySmallUpdates: ArrayBuffer[] = [];
let heavyHistoryUpdates: Uint8Array[] = [];
let heavyHistoryEncoded: Uint8Array = new Uint8Array();

describe("crdt merge", () => {
  bench(
    "offline reconcile merge batch x200 (many small docs)",
    () => {
      mergeBatch(SMALL_BATCH_DATA);
    },
    { teardown: closeTrackedResources },
  );

  bench("offline reconcile merge batch x1000 (many small docs)", () => {
    mergeBatch(MEDIUM_BATCH_DATA);
  });

  bench(
    "materializeDocumentFromUpdate x500 (live-state read path)",
    () => {
      for (let index = 0; index < manySmallUpdates.length; index += 1) {
        const update = manySmallUpdates[index];
        if (!update) continue;
        materializeDocumentFromUpdate({
          schemaDef: definition,
          docId: `doc-${index}`,
          docCreationTime: index + 1,
          update,
        });
      }
    },
    {
      setup: () => {
        manySmallUpdates = Array.from({ length: 500 }, (_, index) =>
          bufferFromUpdate(
            encodeDocumentState(definition, crdtSeedRow(index), 0),
          ),
        );
      },
    },
  );

  bench(
    "raw yjs apply heavily-edited history (2000 edits)",
    () => {
      const doc = new Y.Doc();
      for (const update of heavyHistoryUpdates) {
        Y.applyUpdateV2(doc, update);
      }
      doc.destroy();
    },
    {
      setup: () => {
        heavyHistoryUpdates = buildEditHistory(2_000);
      },
    },
  );

  bench(
    "raw yjs mergeUpdates heavily-edited history (2000 edits)",
    () => {
      mergeUpdate(...heavyHistoryUpdates);
    },
    {
      setup: () => {
        heavyHistoryUpdates = buildEditHistory(2_000);
      },
    },
  );

  bench(
    "raw yjs apply compacted history snapshot (2000 edits)",
    () => {
      const doc = new Y.Doc();
      Y.applyUpdateV2(doc, heavyHistoryEncoded);
      doc.destroy();
    },
    {
      setup: () => {
        heavyHistoryEncoded = mergeUpdate(...buildEditHistory(2_000));
      },
    },
  );
});
