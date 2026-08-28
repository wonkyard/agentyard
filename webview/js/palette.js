// Fixed small palette — deliberately limited for a consistent pixel look.
(function (root) {
  const PALETTE = {
    // environment
    bgTop: '#12141c',
    bgFloor: '#242838',
    floorTile: '#2b3145',
    roomFill: '#343b54',
    roomFillWork: '#3d4a4a',
    roomWall: '#181b26',
    roomLabelBg: '#1f2432',
    desk: '#7a5233',
    deskTop: '#946b41',
    monitor: '#0f1622',
    monitorOn: '#57c7b8',
    text: '#e8e6df',
    textDim: '#9aa0b4',
    // status
    working: '#ffd166',
    idle: '#8b91a7',
    blocked: '#ef476f',
    // accents
    teal: '#2ec4b6',
    yellow: '#ffd166',
    green: '#06d6a0',
    red: '#ef476f',
    purple: '#9b5de5',
    blue: '#4d96ff',
    // people
    skin: ['#f2c8a0', '#e0a878', '#c88a5a', '#a9683f'],
    shirts: ['#2ec4b6', '#ffd166', '#ef476f', '#06d6a0', '#4d96ff', '#9b5de5', '#f78c6b', '#e8e6df'],
    hair: ['#2b2b2b', '#5a3a22', '#8a8a8a', '#c9a227', '#1b1b1b'],
  };

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function pick(arr, seed) {
    return arr[hash(seed) % arr.length];
  }

  function modelColor(model) {
    if (model === 'sonnet') return PALETTE.teal;
    if (model === 'haiku') return PALETTE.yellow;
    return PALETTE.textDim;
  }

  function statusColor(status) {
    if (status === 'working') return PALETTE.working;
    if (status === 'blocked') return PALETTE.blocked;
    return PALETTE.idle;
  }

  root.PO = root.PO || {};
  root.PO.palette = PALETTE;
  root.PO.hash = hash;
  root.PO.pick = pick;
  root.PO.modelColor = modelColor;
  root.PO.statusColor = statusColor;
})(window);
