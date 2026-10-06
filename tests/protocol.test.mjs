import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("canonical hashes use stable ordinal key order across process locales", () => {
  const module = new URL("../dist/protocol.js", import.meta.url).href;
  const code = `import {canonical,digest} from ${JSON.stringify(module)}; const v={i:1,I:2,"ı":3,_:4,A:5,a:6}; console.log(JSON.stringify({canonical:canonical(v),digest:digest(v)}));`;
  const outputs = ["en_US.UTF-8", "tr_TR.UTF-8", "sv_SE.UTF-8"].map((locale) =>
    JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", code], {
        encoding: "utf8",
        env: { ...process.env, LANG: locale, LC_ALL: locale },
      }),
    ),
  );
  assert.equal(outputs[0].canonical, '{"A":5,"I":2,"_":4,"a":6,"i":1,"ı":3}');
  assert.deepEqual(outputs[1], outputs[0]);
  assert.deepEqual(outputs[2], outputs[0]);
});
