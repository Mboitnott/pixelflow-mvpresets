// Reads everything the app needs from the processor and returns clean data.
// Independent of the web server so it can be reused later.

const model = require('./mvrModel');

const MODEL_NAMES = { 28944: 'P20', 28945: 'P10', 29974: 'Q8', 30006: 'P80', 0: 'PixelFlow (virtual)' };

function describeDevice(info, client) {
  if (!info) return null;
  return {
    model: MODEL_NAMES[info.modelId] || `Model ${info.modelId}`,
    name: info.general?.name || '',
    sn: info.sn,
    firmware: typeof info.version === 'string' ? info.version : info.version?.version || '',
    mode: client.mode,
    address: client.ip ? `${client.ip}:${client.port}` : 'sample files',
  };
}

async function readOverview(client) {
  await client.connect();
  const [nodeJson, screensJson, layersJson, templatesJson, inputsJson] = await Promise.all([
    client.get('/node/detail'),
    client.get('/screen/list-detail'),
    client.get('/layers/list-detail'),
    client.get('/layers/template?moduleType=0'),
    client.get('/interface/list-detail'),
  ]);

  const screens = model.normalizeScreens(screensJson);
  const templates = model.normalizeTemplates(templatesJson);
  const inputs = model.normalizeInputs(inputsJson);

  const mvrs = screens
    .filter((s) => s.isMvr)
    .map((s) => ({
      screenId: s.screenId,
      name: s.name,
      currentTemplate: s.currentTemplate,
      layoutKey: model.detectLayout(templates, s.currentTemplate)?.key || null,
      boxes: model.normalizeMvrLayers(layersJson, s.screenId),
    }));

  return {
    device: describeDevice(nodeJson.data, client),
    mvrs,
    templates,
    inputs,
    screens: model.pickableScreens(screens),
  };
}

module.exports = { readOverview };
