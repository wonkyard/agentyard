// The single source of truth for colour. Deliberately small and fixed so the
// whole scene reads as one designed pixel-art set. Nothing else defines a hex.
(function (root) {
  const PALETTE = {
    // --- environment ---
    bgTop: '#12141c',
    bgFloor: '#1d2130',
    hallFloor: '#232838',
    hallTile: '#1f2434',
    // --- HQ department room ---
    roomFill: '#333b58',
    roomWall: '#20263a',
    roomWallHi: '#2b3350',
    roomFloor: '#3a4260',
    roomFloorAlt: '#343c58',
    roomFloorWork: '#3c4a4a',
    roomFloorWorkAlt: '#374442',
    roomLabelBg: '#171b2a',
    roomShadow: '#161a28',
    // --- project annex building ---
    annexWall: '#4a3a2e',
    annexWallHi: '#5c4838',
    annexRoof: '#7a4a3a',
    annexRoofHi: '#8f5a46',
    annexFloor: '#5a4a3a',
    annexFloorAlt: '#524234',
    annexSign: '#caa15a',
    annexShadow: '#2a2018',
    // --- furniture ---
    desk: '#6b4a2f',
    deskTop: '#8a623d',
    deskLeg: '#4f371f',
    chair: '#242a3c',
    chairLeg: '#1a1e2b',
    keyboard: '#161a24',
    monitorCase: '#1a1e2a',
    monitor: '#0e1520',
    monitorOn: '#57c7b8',
    monitorText: '#7fded1',
    monitorTextHi: '#d6f5f0',
    pot: '#8a5a3a',
    potRim: '#a06a44',
    stem: '#3f6b3a',
    leaf: '#3f8f4a',
    leafHi: '#5cb85c',
    door: '#3a2c1e',
    doorPanel: '#4a3826',
    brass: '#caa15a',
    rug1: '#3a3350',
    rug2: '#4a4068',
    // --- text ---
    text: '#e8e6df',
    textDim: '#9aa0b4',
    textFaint: '#6b7189',
    eye: '#15171f',
    // --- status ---
    working: '#ffd166',
    idle: '#8b91a7',
    blocked: '#ef476f',
    // --- accents ---
    accentTeal: '#2ec4b6',
    yellow: '#ffd166',
    green: '#06d6a0',
    red: '#ef476f',
    purple: '#9b5de5',
    blue: '#4d96ff',
    // --- speech / thought ---
    bubble: '#f4f1e6',
    bubbleDim: '#c9c6ba',
    bubbleText: '#2b3145',
    // --- people ---
    skin: ['#f2c8a0', '#e0a878', '#c88a5a', '#a9683f', '#8a5a3e'],
    shirts: ['#2ec4b6', '#ffd166', '#ef476f', '#06d6a0', '#4d96ff', '#9b5de5', '#f78c6b', '#c9c6ba'],
    hair: ['#2b2b2b', '#5a3a22', '#8a8a8a', '#c9a227', '#1b1b1b', '#6b4f8a'],
    pants: '#2f3346',
    shoe: '#14161d',
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
    if (model === 'sonnet') return PALETTE.accentTeal;
    if (model === 'haiku') return PALETTE.yellow;
    return PALETTE.textDim;
  }

  function statusColor(status) {
    if (status === 'working') return PALETTE.working;
    if (status === 'blocked') return PALETTE.blocked;
    return PALETTE.idle;
  }

  root.AY = root.AY || {};
  root.AY.palette = PALETTE;
  root.AY.hash = hash;
  root.AY.pick = pick;
  root.AY.modelColor = modelColor;
  root.AY.statusColor = statusColor;
})(window);
