"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { JsonFileStore } = require("./json-store");

test("creates JSON storage and preserves concurrent updates", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imara-json-store-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "records.json");
  const store = new JsonFileStore(filePath);

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.update((records) => {
        records.mentors.push({ id: index });
      }),
    ),
  );

  const records = await store.read();
  assert.equal(records.mentors.length, 20);
  assert.deepEqual(records.donations, []);
  assert.deepEqual(records.callbacks, []);
  assert.equal(
    JSON.parse(await fs.readFile(filePath, "utf8")).mentors.length,
    20,
  );
});

test("does not overwrite malformed JSON storage", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "imara-json-store-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "records.json");
  await fs.writeFile(filePath, "{invalid");
  const store = new JsonFileStore(filePath);

  await assert.rejects(store.initialize(), /invalid JSON/);
  assert.equal(await fs.readFile(filePath, "utf8"), "{invalid");
});
