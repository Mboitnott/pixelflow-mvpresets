// Saves presets as a JSON file. A preset looks like:
// {
//   id: "mv2-show-open",              // used in the Companion URL
//   name: "Show open",
//   mvrScreenId: 2,
//   layout: { templateId, templateType, key, label },
//   cells: [{ index, sourceType, rect, source: { sourceType, sourceId, name } | null }]
// }

const fs = require('fs');
const path = require('path');

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'preset'
  );
}

function createPresetStore(filePath) {
  function readAll() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  function writeAll(list) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, filePath); // atomic swap so a crash can't leave half a file
  }

  function uniqueId(base, list, ignoreId) {
    let id = slugify(base);
    let n = 2;
    while (list.some((p) => p.id === id && p.id !== ignoreId)) id = `${slugify(base)}-${n++}`;
    return id;
  }

  return {
    list: readAll,
    get: (id) => readAll().find((p) => p.id === id) || null,
    save(preset) {
      const list = readAll();
      const idx = preset.id ? list.findIndex((p) => p.id === preset.id) : -1;
      if (idx >= 0) {
        list[idx] = preset;
      } else {
        preset.id = uniqueId(preset.id || preset.name, list);
        list.push(preset);
      }
      writeAll(list);
      return preset;
    },
    remove(id) {
      const list = readAll();
      const next = list.filter((p) => p.id !== id);
      writeAll(next);
      return next.length !== list.length;
    },
    uniqueId: (base, ignoreId) => uniqueId(base, readAll(), ignoreId),
  };
}

module.exports = { createPresetStore, slugify };
