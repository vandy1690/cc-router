#!/usr/bin/env node
// Test harness for project/chat recall. Usage:
//   node src/projects-cli.js            (list projects + recent chats)

const { allProjects } = require("./sessions");

(async () => {
  const projects = await allProjects({ limit: 8 });
  for (const p of projects) {
    console.log(`\n■ ${p.name}  —  ${p.cwd}`);
    for (const c of p.chats.slice(0, 6)) {
      const when = c.updated.slice(0, 16).replace("T", " ");
      console.log(`   • ${when}  ${c.title}`);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
