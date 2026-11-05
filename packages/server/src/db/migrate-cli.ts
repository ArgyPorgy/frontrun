import { closeDb } from "./client";
import { runMigrations } from "./migrate";

runMigrations()
  .then(() => {
    console.log("migrations applied");
    return closeDb();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
