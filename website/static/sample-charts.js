(function () {
  var NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs, text) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  function showTip(chart, tip, x, y, html) {
    var svg = chart.querySelector('svg'), r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.left = (svg.offsetLeft + x / vb.width * r.width) + 'px';
    tip.style.top = (svg.offsetTop + y / vb.height * r.height) + 'px';
  }

  /* Grouped bars: sample figures, millions of UNI per week */
  var weeks = ['Oct 6', 'Oct 13', 'Oct 20', 'Oct 27'];
  var series = [
    { name: 'v2', color: 'var(--s1)', values: [0.90, 0.80, 0.85, 1.00] },
    { name: 'v3', color: 'var(--s2)', values: [4.00, 3.70, 4.70, 4.30] },
    { name: 'v4', color: 'var(--s3)', values: [1.40, 1.70, 2.00, 2.50] }
  ];
  (function bars() {
    var chart = document.getElementById('bars'), svg = chart.querySelector('svg'), tip = chart.querySelector('.tip');
    var left = 44, right = 620, top = 16, bottom = 250, max = 5;
    var y = function (v) { return bottom - v / max * (bottom - top); };
    var groupW = (right - left) / weeks.length, barW = 30, gap = 2;
    for (var t = 0; t <= max; t += 1) {
      svg.appendChild(el('line', { x1: left, x2: right, y1: y(t), y2: y(t), 'class': 'grid-line' }));
      var lab = el('text', { x: left - 8, y: y(t) + 4, 'text-anchor': 'end', 'class': 'label' }, t + (t === max ? 'M' : ''));
      svg.appendChild(lab);
    }
    svg.appendChild(el('line', { x1: left, x2: right, y1: bottom, y2: bottom, 'class': 'baseline' }));
    weeks.forEach(function (w, i) {
      var gx = left + i * groupW + (groupW - (barW * 3 + gap * 2)) / 2;
      series.forEach(function (s, j) {
        var v = s.values[i], x = gx + j * (barW + gap);
        var bar = el('rect', { x: x, y: y(v), width: barW, height: bottom - y(v), rx: 4, fill: s.color, 'class': 'bar' });
        svg.appendChild(bar);
        svg.appendChild(el('text', { x: x + barW / 2, y: y(v) - 5, 'text-anchor': 'middle', 'class': 'label' }, v.toFixed(1)));
        var hit = el('rect', { x: x - 2, y: top, width: barW + 4, height: bottom - top, 'class': 'hit' });
        hit.addEventListener('mouseenter', function () {
          svg.querySelectorAll('.bar').forEach(function (b) { if (b !== bar) b.classList.add('dim'); });
          showTip(chart, tip, x + barW / 2, y(v), 'Week of ' + w + ' · ' + s.name + ': <strong>' + v.toFixed(2) + 'M UNI</strong>');
        });
        hit.addEventListener('mouseleave', function () {
          svg.querySelectorAll('.bar').forEach(function (b) { b.classList.remove('dim'); });
          tip.hidden = true;
        });
        svg.appendChild(hit);
      });
      svg.appendChild(el('text', { x: left + i * groupW + groupW / 2, y: bottom + 20, 'text-anchor': 'middle', 'class': 'label' }, 'Week of ' + w));
    });
    var tbody = document.getElementById('bars-table');
    weeks.forEach(function (w, i) {
      var v2 = series[0].values[i], v3 = series[1].values[i], v4 = series[2].values[i], total = v2 + v3 + v4;
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>2026 ' + w + '</td><td class="num">' + v2.toFixed(2) + '</td><td class="num">' + v3.toFixed(2) + '</td><td class="num">' + v4.toFixed(2) + '</td><td class="num">' + total.toFixed(2) + '</td><td class="num">' + (v4 / total * 100).toFixed(1) + '%</td>';
      tbody.appendChild(tr);
    });
  })();

  /* Lines: sample daily prices, 28 days ending 2026-11-02 */
  var binance = [7.42, 7.51, 7.38, 7.29, 7.46, 7.63, 7.71, 7.58, 7.49, 7.66, 7.84, 7.92, 8.05, 7.97, 7.88, 8.11, 8.24, 8.19, 8.33, 8.46, 8.38, 8.29, 8.52, 8.61, 8.74, 8.69, 8.57, 8.63];
  var offsets = [0.2, -0.1, 0.3, 0.1, -0.2, 0.4, 0.0, -0.3, 0.2, 0.1, -0.1, 0.3, 0.2, -0.4, 0.1, 0.0, 0.3, -0.2, 0.1, 0.4, -0.1, 0.2, 0.0, -0.3, 0.1, 0.2, -0.2, 0.1];
  var chainlink = binance.map(function (p, i) { return +(p * (1 + offsets[i] / 100)).toFixed(2); });
  var days = []; var d0 = new Date(Date.UTC(2026, 9, 6));
  for (var i = 0; i < 28; i++) { var d = new Date(d0.getTime() + i * 864e5); days.push(d); }
  function fmt(d) { return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  (function lines() {
    var chart = document.getElementById('lines'), svg = chart.querySelector('svg'), tip = chart.querySelector('.tip');
    var left = 48, right = 620, top = 16, bottom = 214, min = 7, max = 9;
    var x = function (i) { return left + i / (days.length - 1) * (right - left); };
    var y = function (v) { return bottom - (v - min) / (max - min) * (bottom - top); };
    for (var t = min; t <= max; t += 0.5) {
      svg.appendChild(el('line', { x1: left, x2: right, y1: y(t), y2: y(t), 'class': 'grid-line' }));
      svg.appendChild(el('text', { x: left - 8, y: y(t) + 4, 'text-anchor': 'end', 'class': 'label' }, '$' + t.toFixed(2)));
    }
    svg.appendChild(el('line', { x1: left, x2: right, y1: bottom, y2: bottom, 'class': 'baseline' }));
    [0, 7, 14, 21, 27].forEach(function (i) {
      svg.appendChild(el('text', { x: x(i), y: bottom + 20, 'text-anchor': i === 27 ? 'end' : (i === 0 ? 'start' : 'middle'), 'class': 'label' }, fmt(days[i])));
    });
    var path = function (vals, color) {
      var d = vals.map(function (v, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); }).join(' ');
      return el('path', { d: d, stroke: color, 'class': 'line' });
    };
    svg.appendChild(path(binance, 'var(--s1)'));
    svg.appendChild(path(chainlink, 'var(--s2)'));
    var last = days.length - 1;
    svg.appendChild(el('circle', { cx: x(last), cy: y(binance[last]), r: 4, fill: 'var(--s1)', 'class': 'dot' }));
    svg.appendChild(el('text', { x: x(last) - 8, y: y(binance[last]) - 10, 'text-anchor': 'end', 'class': 'label' }, '$' + binance[last].toFixed(2)));
    var cross = el('line', { y1: top, y2: bottom, 'class': 'crosshair' }); cross.setAttribute('visibility', 'hidden'); svg.appendChild(cross);
    var dotB = el('circle', { r: 5, fill: 'var(--s1)', 'class': 'dot', visibility: 'hidden' }), dotC = el('circle', { r: 5, fill: 'var(--s2)', 'class': 'dot', visibility: 'hidden' });
    svg.appendChild(dotB); svg.appendChild(dotC);
    var hit = el('rect', { x: left, y: top, width: right - left, height: bottom - top, 'class': 'hit' });
    hit.addEventListener('mousemove', function (ev) {
      var r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
      var px = (ev.clientX - r.left) / r.width * vb.width;
      var i = Math.round((px - left) / (right - left) * (days.length - 1)); i = Math.max(0, Math.min(last, i));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dotB.setAttribute('cx', x(i)); dotB.setAttribute('cy', y(binance[i])); dotB.setAttribute('visibility', 'visible');
      dotC.setAttribute('cx', x(i)); dotC.setAttribute('cy', y(chainlink[i])); dotC.setAttribute('visibility', 'visible');
      var diff = ((chainlink[i] / binance[i] - 1) * 100).toFixed(2);
      showTip(chart, tip, x(i), Math.min(y(binance[i]), y(chainlink[i])), fmt(days[i]) + ' · Binance <strong>$' + binance[i].toFixed(2) + '</strong> · Chainlink <strong>$' + chainlink[i].toFixed(2) + '</strong> (' + (diff > 0 ? '+' : '') + diff + '%)');
    });
    hit.addEventListener('mouseleave', function () {
      cross.setAttribute('visibility', 'hidden'); dotB.setAttribute('visibility', 'hidden'); dotC.setAttribute('visibility', 'hidden'); tip.hidden = true;
    });
    svg.appendChild(hit);
  })();
})();
