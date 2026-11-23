// Stand-in for the processor that answers GETs from the saved JSON in samples/.
// Used when no processor IP is set, so the UI can be built and tested offline.

const fs = require('fs');
const path = require('path');

const ROUTES = {
  '/node/open-detail': 'node.json',
  '/node/detail': 'node.json',
  '/screen/list-detail': 'screens.json',
  '/layers/list-detail': 'layers.json',
  '/layers/template?moduleType=0': 'mvr_templates.json',
  '/interface/list-detail': 'inputs.json',
};

const NO_PROCESSOR = 'No processor set. Click "Processor…" (top right) and enter its IP address.';

function createSampleClient({ samplesDir }) {
  const available = fs.existsSync(path.join(samplesDir, 'node.json'));

  function load(file) {
    if (!available) throw new Error(NO_PROCESSOR);
    return JSON.parse(fs.readFileSync(path.join(samplesDir, file), 'utf8'));
  }

  async function get(p) {
    const [base, query] = p.split('?');
    if (base === '/layers/list-detail' && query) {
      const id = Number(new URLSearchParams(query).get('attachScreenId'));
      const json = load('layers.json');
      json.data.list = json.data.list.filter((l) => l.layerIdObj.attachScreenId === id);
      return json;
    }
    const file = ROUTES[p];
    if (!file) throw new Error(`Sample mode has no data for ${p}`);
    return load(file);
  }

  return {
    mode: 'sample',
    available,
    ip: null,
    port: null,
    connect: async () => (await get('/node/open-detail')).data,
    getDeviceInfo: () => load('node.json').data,
    get,
    put: async () => {
      throw new Error(available ? 'Sample mode is read-only. Set the processor IP to make changes.' : NO_PROCESSOR);
    },
  };
}

module.exports = { createSampleClient };
