import { access, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function toLocaleExportName(fileName) {
  const baseName = fileName.replace(/\.js$/u, "");
  return baseName
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

async function ensureZodLocalesIndex() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const bunStoreDir = path.join(scriptDir, "..", "node_modules", ".bun");

  let storeEntries;
  try {
    storeEntries = await readdir(bunStoreDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of storeEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith("zod@")) {
      continue;
    }

    const localesDir = path.join(bunStoreDir, entry.name, "node_modules", "zod", "v4", "locales");
    const indexPath = path.join(localesDir, "index.js");

    try {
      await access(indexPath);
      continue;
    } catch {
      // The package is installed without the generated index; repair it below.
    }

    let localeFiles;
    try {
      localeFiles = await readdir(localesDir);
    } catch {
      continue;
    }

    const exportLines = localeFiles
      .filter((fileName) => fileName.endsWith(".js") && fileName !== "index.js")
      .toSorted((left, right) => left.localeCompare(right))
      .map((fileName) => {
        const exportName = toLocaleExportName(fileName);
        return `export { default as ${exportName} } from "./${fileName}";`;
      });

    if (exportLines.length === 0) {
      continue;
    }

    await writeFile(indexPath, `${exportLines.join("\n")}\n`, "utf8");
  }
}

await ensureZodLocalesIndex();
