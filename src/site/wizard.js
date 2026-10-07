// Draw the Wizard's authored pixel sprite at its original integer scale.
(function () {
  'use strict';

  var canvas = document.querySelector('canvas[data-wizard-portrait]');
  if (!canvas) return;

  var palette = {
    '.': null, 'o': '#17141f', 'p': '#4a3f9c', 'P': '#2e2a6b',
    'y': '#f0c94a', 's': '#f2cba3', 'W': '#f5f5f8', 'w': '#d2d2de',
    't': '#8a5a30', 'c': '#a8e6de',
  };
  var frame = [
    '...p...cc', '..ppp..cc', '.pyppp..t', 'yyyyyyy.t',
    '.sosos..t', '.sWWWs..t', 'pWWWWWp.t', '.ppypp..t',
  ];
  var dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
  var pixel = 4;
  canvas.width = 9 * pixel * dpr;
  canvas.height = 8 * pixel * dpr;
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  for (var y = 0; y < frame.length; y++) {
    for (var x = 0; x < frame[y].length; x++) {
      var color = palette[frame[y][x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x * pixel, y * pixel, pixel, pixel);
    }
  }
})();
