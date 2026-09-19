/** Regenerate public fixture data through the real API without recording video. */
process.argv.push("--data-only");
await import("./capture-demo.js");
export {};
