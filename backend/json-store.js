"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function createEmptyRecords() {
  return {
    mentors: [],
    donations: [],
    callbacks: [],
  };
}

class JsonFileStore {
  constructor(filePath) {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new Error("A JSON storage file path is required.");
    }

    this.filePath = path.resolve(filePath);
    this.initialization = null;
    this.writeQueue = Promise.resolve();
  }

  initialize() {
    if (!this.initialization) {
      this.initialization = this.createStorageFile();
    }
    return this.initialization;
  }

  async read() {
    await this.initialize();
    await this.writeQueue;
    return this.readRecords();
  }

  update(mutator) {
    if (typeof mutator !== "function") {
      throw new Error("A JSON storage update function is required.");
    }

    const operation = this.writeQueue.then(async () => {
      await this.initialize();
      const records = await this.readRecords();
      await mutator(records);
      await this.writeRecords(records);
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async createStorageFile() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });

    let handle;
    try {
      handle = await fs.open(this.filePath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      await this.readRecords();
      return;
    }

    try {
      await handle.writeFile(
        `${JSON.stringify(createEmptyRecords(), null, 2)}\n`,
      );
      await handle.sync();
    } catch (error) {
      try {
        await handle.close();
      } catch (closeError) {
        error.cause = closeError;
      }
      try {
        await fs.unlink(this.filePath);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") {
          error.cause = cleanupError;
        }
      }
      throw error;
    }
    await handle.close();
  }

  async readRecords() {
    const contents = await fs.readFile(this.filePath, "utf8");
    let records;
    try {
      records = JSON.parse(contents);
    } catch (error) {
      throw new Error("JSON storage file contains invalid JSON.", {
        cause: error,
      });
    }

    if (
      !records ||
      typeof records !== "object" ||
      !Array.isArray(records.mentors) ||
      !Array.isArray(records.donations) ||
      !Array.isArray(records.callbacks)
    ) {
      throw new Error("JSON storage file has an invalid records structure.");
    }
    return records;
  }

  async writeRecords(records) {
    const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(records, null, 2)}\n`);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, this.filePath);
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch (closeError) {
          error.cause = closeError;
        }
      }
      try {
        await fs.unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") {
          error.cause = cleanupError;
        }
      }
      throw error;
    }
  }
}

module.exports = { JsonFileStore };
