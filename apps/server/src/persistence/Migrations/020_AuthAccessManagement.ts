import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ensureAuthAccessManagementSchema } from "./AuthSchema.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* ensureAuthAccessManagementSchema(sql);
});
