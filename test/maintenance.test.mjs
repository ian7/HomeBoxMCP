import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startStubHomebox } from "./helpers/stub-homebox.mjs";
import { startShim } from "./helpers/shim.mjs";

const ENTRY = {
  id: "m-1",
  name: "Change oil",
  description: "5W-30",
  completedDate: "",
  scheduledDate: "2026-03-01T00:00:00Z",
  cost: "12.5",
  itemName: "Mower",
};

describe("maintenance tools", () => {
  let homebox;
  let shim;
  let n = 0;

  const call = async (name, args) => {
    const res = await shim.rpc({
      jsonrpc: "2.0",
      id: ++n,
      method: "tools/call",
      params: { name, arguments: args },
    });
    assert.equal(res.status, 200, res.text);
    return res.body.result;
  };
  const ok = async (name, args) => {
    const r = await call(name, args);
    assert.equal(r.isError, false, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };

  before(async () => {
    homebox = await startStubHomebox({
      routes: {
        "GET /api/v1/maintenance": (rec, json) => json(200, [ENTRY]),
        "GET /api/v1/entities/ent-1/maintenance": (rec, json) => json(200, [ENTRY]),
        "POST /api/v1/entities/ent-1/maintenance": (rec, json) =>
          json(201, { id: "m-new", ...rec.json }),
        "PUT /api/v1/maintenance/m-1": (rec, json) => json(200, { id: "m-1", ...rec.json }),
        "DELETE /api/v1/maintenance/m-1": (rec, json, res) => {
          res.writeHead(204);
          res.end();
        },
      },
    });
    shim = await startShim({ homeboxUrl: homebox.url });
  });

  after(async () => {
    await shim?.stop();
    await homebox?.close();
  });

  it("list_maintenance without id hits the global list and trims the output", async () => {
    const out = await ok("list_maintenance", {});
    assert.deepEqual(out, [
      {
        id: "m-1",
        name: "Change oil",
        description: "5W-30",
        scheduledDate: "2026-03-01",
        cost: "12.5",
        item: "Mower",
      },
    ]);
    const req = homebox.matching("/maintenance").at(-1);
    assert.equal(req.query.status, "both");
  });

  it("list_maintenance with id is scoped to that entity and passes status", async () => {
    await ok("list_maintenance", { id: "ent-1", status: "scheduled" });
    const req = homebox.matching("/entities/ent-1/maintenance").at(-1);
    assert.equal(req.method, "GET");
    assert.equal(req.query.status, "scheduled");
  });

  it("list_maintenance rejects an invalid status without calling Homebox", async () => {
    const before = homebox.requests.length;
    const r = await call("list_maintenance", { status: "nope" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /status must be one of/);
    assert.equal(homebox.requests.slice(before).filter((x) => x.path.includes("maintenance")).length, 0);
  });

  it("log_maintenance normalises dates and sends cost as a string", async () => {
    const out = await ok("log_maintenance", {
      id: "ent-1",
      name: "Sharpen blades",
      completedDate: "2026-02-10",
      cost: 7.5,
    });
    assert.equal(out.id, "m-new");
    const req = homebox.requests.find((r) => r.method === "POST" && r.path.endsWith("/entities/ent-1/maintenance"));
    assert.equal(req.json.completedDate, "2026-02-10T00:00:00Z");
    assert.equal(req.json.cost, "7.5");
    assert.equal(req.json.scheduledDate, undefined);
  });

  it("update_maintenance preserves unpatched fields in the full PUT", async () => {
    await ok("update_maintenance", { entryId: "m-1", completedDate: "2026-03-02" });
    const req = homebox.requests.find((r) => r.method === "PUT" && r.path === "/api/v1/maintenance/m-1");
    assert.deepEqual(req.json, {
      name: "Change oil",
      description: "5W-30",
      completedDate: "2026-03-02T00:00:00Z",
      scheduledDate: "2026-03-01T00:00:00Z",
      cost: "12.5",
    });
  });

  it("update_maintenance reports an unknown entry", async () => {
    const r = await call("update_maintenance", { entryId: "missing", name: "x" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no maintenance entry with id 'missing'/);
  });

  it("delete_maintenance surfaces a Homebox error for an unknown entry", async () => {
    const r = await call("delete_maintenance", { entryId: "missing" });
    assert.equal(r.isError, true);
  });

  it("delete_maintenance deletes by id", async () => {
    const out = await ok("delete_maintenance", { entryId: "m-1" });
    assert.deepEqual(out, { deleted: "m-1" });
    assert.ok(homebox.requests.some((r) => r.method === "DELETE" && r.path === "/api/v1/maintenance/m-1"));
  });
});
