import { ensureDatabaseReady } from "@/lib/storage/db";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await ensureDatabaseReady();
  }
}
