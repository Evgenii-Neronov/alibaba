const player = $('#player')[0];
const canvas = $('#wave')[0];
const viewport = $('#wave-scroll')[0];
const ctx = canvas.getContext('2d');
let data, url, envelope, marks = [], generation = 0;
const stamp = seconds => new Date(seconds * 1000).toISOString().slice(14, 23);
const format = ms => Math.round(ms) + ' мс';

$('#upload').on('submit', async event => {
    event.preventDefault();
    const request = ++generation;
    const form = new FormData();
    form.append('file', $('#file')[0].files[0]);
    $('#status').text('Извлекаю аудио…');
    try {
        const blob = await $.ajax({url:'/api/audio', method:'POST', data:form,
            contentType:false, processData:false, xhrFields:{responseType:'blob'}});
        const decoder = new AudioContext();
        let decoded;
        try { decoded = await decoder.decodeAudioData(await blob.arrayBuffer()); }
        finally { await decoder.close(); }
        if (request !== generation) return;
        player.pause();
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(blob);
        player.src = url;
        data = decoded;
        marks = [];
        $('#end, #start').val('');
        $('#zoom').val(0);
        $('#analysis').prop('hidden', false);
        $('#status').text('Длительность аудио — ' + stamp(data.duration));
        resize();
        updateMarks();
    } catch (error) {
        if (request !== generation) return;
        let message = error.message || 'Не удалось обработать файл.';
        try {
            const payload = JSON.parse(await error.response.text());
            message = payload.error || payload.detail || message;
        } catch {}
        if (request === generation) $('#status').text(message);
    }
});

function resize() {
    if (!data) return;
    const ratio = 2 ** Number($('#zoom').val());
    $('#zoom-value').text(ratio + '×');
    const visible = viewport.clientWidth;
    const oldCenter = (viewport.scrollLeft + visible / 2) / canvas.width;
    canvas.width = Math.min(32760, visible * ratio);
    canvas.height = 176;
    const pcm = data.getChannelData(0);
    envelope = new Float32Array(canvas.width * 2);
    for (let x = 0; x < canvas.width; x++) {
        const start = Math.floor(x * pcm.length / canvas.width);
        const end = Math.floor((x + 1) * pcm.length / canvas.width);
        let low = 0, high = 0;
        for (let i = start; i < Math.max(start + 1, end); i++) {
            low = Math.min(low, pcm[i]); high = Math.max(high, pcm[i]);
        }
        envelope[x * 2] = low;
        envelope[x * 2 + 1] = high;
    }
    viewport.scrollLeft = oldCenter * canvas.width - visible / 2;
    draw();
}

function draw() {
    if (!data || !envelope) return;
    const w = canvas.width;
    const pos = s => s / data.duration * w;
    const left = viewport.scrollLeft;
    const right = Math.min(w, left + viewport.clientWidth);
    ctx.clearRect(left, 0, right - left, 176);
    ctx.strokeStyle = '#265ea6';
    ctx.beginPath();
    for (let x = left | 0; x < right; x++) {
        ctx.moveTo(x + .5, 72 - envelope[x * 2 + 1] * 67);
        ctx.lineTo(x + .5, 73 - envelope[x * 2] * 67);
    }
    ctx.stroke();
    const target = 85 * data.duration / w;
    const power = 10 ** Math.floor(Math.log10(target));
    const step = [1, 2, 5, 10].find(v => v * power >= target) * power;
    ctx.fillStyle = '#435570';
    ctx.font = '11px monospace';
    for (let i = Math.ceil(left / pos(step)); pos(i * step) < right; i++) {
        const x = pos(i * step);
        ctx.fillRect(x, 143, 1, 8);
        ctx.fillText(stamp(i * step), x + 3, 165);
    }
    for (const [value, color] of [[player.currentTime,'#222'], [$('#end').val(),'#da7800'], [$('#start').val(),'#00875a']]) {
        if (value === '') continue;
        ctx.fillStyle = color;
        ctx.fillRect(pos(Number(value)), 0, 2, 143);
    }
}

$(window).on('resize', resize);
$('#zoom').on('input', resize);
$(viewport).on('scroll', draw);
$(player).on('timeupdate seeked', draw);
$(canvas).on('click', event => {
    player.currentTime = Math.min(data.duration, event.offsetX / canvas.width * data.duration);
    draw();
});
$('#end, #start').on('input', draw);
$('[data-mark]').on('click', event => {
    $('#' + event.currentTarget.dataset.mark).val(player.currentTime.toFixed(3));
    draw();
});
$('#record').on('click', () => {
    const cells = [$('#end').val(), $('#start').val()];
    const [end, start] = cells.map(Number);
    if (cells.includes('') || [end,start].some(t => !Number.isFinite(t) || t < 0 || t > data.duration)) {
        $('#metrics').text('Укажите обе отметки в пределах записи.');
        return;
    }
    marks.push({end,start,delta:(start-end)*1000});
    updateMarks();
});
function updateMarks() {
    const rows = $('#marks').empty();
    marks.forEach((mark, index) => {
        const row = $('<tr>').appendTo(rows);
        [stamp(mark.end), stamp(mark.start), format(mark.delta)].forEach(value => $('<td>').text(value).appendTo(row));
        $('<button class="btn btn-sm btn-outline-secondary">Удалить</button>').on('click', () => {
            marks.splice(index, 1); updateMarks();
        }).appendTo($('<td>').appendTo(row));
    });
    const values = marks.map(m => m.delta).sort((a,b) => a-b);
    const n = values.length;
    const median = (values[Math.floor((n-1)/2)] + values[Math.floor(n/2)]) / 2;
    $('#metrics').text(n ? `Замеров ${n} · Среднее ${format(values.reduce((a,b)=>a+b,0)/n)} · Медиана ${format(median)} · P90 ${format(values[Math.ceil(n*.9)-1])}` : '');
}
