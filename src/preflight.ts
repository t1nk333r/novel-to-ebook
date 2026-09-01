import { existsSync } from "node:fs";

const errors: string[] = [];
if (!process.env.DATABASE_URL?.trim()) errors.push("DATABASE_URL is not set");
if (!existsSync("./ui/dist/index.html")) errors.push("ui/dist/index.html is missing; run pnpm build");

if (errors.length) {
  console.error(`Cannot start Storvi in production:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
