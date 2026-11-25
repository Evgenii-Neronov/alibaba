const candidates = ['qwen3.8-flash','qwen3.7-flash','qwen3.6-flash','qwen-flash'];
let history = [], controller, catalog = [], loadingModels = false;
const ms = value => value == null ? '—' : Math.round(value) + ' мс';
const timing = stats => `TTFB ${ms(stats.ttfb)} · Первый текст ${ms(stats.firstText)} · Всего ${ms(stats.total)}`;
function setModels(ids) {
    const select = $('#model');
    const previous = select.val();
    catalog = [...new Set(ids)].sort();
    select.empty();
    const preferred = candidates.filter(id => catalog.includes(id));
    const groups = [
        ['Быстрые модели Qwen', preferred],
        ['Остальные модели каталога', catalog.filter(id => !preferred.includes(id))]
    ];
    for (const [label, models] of groups) {
        if (!models.length) continue;
        const group = $('<optgroup>').attr('label', label).appendTo(select);
        models.forEach(id => $('<option>').val(id).text(id).appendTo(group));
    }
    if (!catalog.length) {
        select.append($('<option>').val('').text('Модели недоступны'));
        return;
    }
    select.val(catalog.includes(previous) ? previous : preferred[0] || catalog[0]);
}
function statusMessage(status) {
    if (status === 401) return 'Проверьте ключ и регион эндпоинта.';
    if (status === 403) return 'Проверьте права ключа, доступ к модели и активность аккаунта.';
    if (status === 429) return 'Проверьте лимит запросов и доступную квоту.';
    return '';
}
async function errorMessage(status, body) {
    let detail, code;
    try {
        const payload = JSON.parse(body);
        code = payload.error?.code || payload.code;
        detail = payload.error?.message || payload.error || payload.message || payload.detail;
    } catch {}
    if (code === 'AccessDenied.Unpurchased') return 'HTTP 403 · Alibaba отклонила генерацию для этой модели (AccessDenied.Unpurchased). Проверьте активацию Model Studio и доступ к модели в настройках ключа или подписки.';
    return [status ? 'HTTP ' + status : '', typeof detail === 'string' ? detail : '', statusMessage(status)].filter(Boolean).join(' · ');
}
async function refreshModels() {
    loadingModels = true;
    setBusy(false);
    $('#availability').text('Запрашиваю каталог моделей…');
    try {
        const result = await $.ajax({url:'/api/models',dataType:'json'});
        const ids = (result.data || []).map(item => item.id).filter(id => typeof id === 'string');
        if (!ids.length) throw new Error('Эндпоинт вернул пустой каталог.');
        setModels(ids);
        $('#availability').text(`Ключ принят каталогом. Моделей в списке: ${ids.length}. Доступ к генерации проверяется запросом в чате.`);
    } catch (err) {
        $('#availability').text(err.message || await errorMessage(err.status, err.responseText) || 'Подключение прервано.');
        if (!catalog.length) setModels([]);
    } finally {
        loadingModels = false;
        setBusy(false);
    }
}
$('#refresh').on('click', refreshModels);
async function stream(model, messages, benchmark, signal, onProgress) {
    const started = performance.now();
    const res = await fetch('/api/chat', {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model,messages,benchmark,disableThinking:$('#thinking').is(':checked')}),signal});
    if (!res.ok) throw new Error(await errorMessage(res.status, await res.text()));
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const stats = {};
    let pending = '', output = '', done = false;
    try {
        while (!done) {
            const {value,done:eof} = await reader.read();
            if (eof) break;
            stats.ttfb ??= performance.now() - started;
            pending += decoder.decode(value,{stream:true});
            const lines = pending.split('\n');
            pending = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const json = line.slice(5).trim();
                if (json === '[DONE]') { done = true; break; }
                const message = JSON.parse(json);
                if (message.error) throw new Error(message.error.message || 'Ошибка в потоке Alibaba.');
                const part = message.choices?.[0]?.delta?.content;
                if (typeof part === 'string' && part.length) {
                    stats.firstText ??= performance.now() - started;
                    output += part;
                }
            }
            onProgress(stats, output);
        }
        if (!done) throw new Error('Поток оборвался до завершения ответа.');
        if (!output) throw new Error('Модель завершила поток без текста.');
        stats.total = performance.now() - started;
        onProgress(stats, output);
        return {stats, output};
    } finally { await reader.cancel().catch(() => {}); }
}
function addMessage(label, value) {
    const block = $('<div>').appendTo('#dialog');
    $('<strong>').text(label).appendTo(block);
    return $('<p>').text(value).appendTo(block);
}
function setBusy(active) {
    const unavailable = active || loadingModels || !catalog.length;
    $('#model, #chat button[type=submit], #bench').prop('disabled', unavailable);
    $('#refresh').prop('disabled', active || loadingModels);
    $('#reset, #thinking').prop('disabled', active);
    $('#stop').prop('disabled', !active);
}
$('#stop').on('click', () => controller?.abort());
$('#reset').on('click', () => { history = []; $('#dialog, #timing').empty(); });
$('#chat').on('submit',async event => {
    event.preventDefault();
    const content = $('#prompt').val().trim();
    const model = $('#model').val();
    if (controller || loadingModels || !content || !catalog.includes(model)) return;
    const user = {role:'user',content};
    addMessage('Вы', content);
    const answer = addMessage(model, '');
    $('#prompt').val('');
    controller = new AbortController();
    setBusy(true);
    $('#timing').text('Ожидаю ответ…');
    try {
        const result = await stream(model,[...history.slice(-98),user],false,controller.signal,(stats, output) => {
            answer.text(output);
            const dialog = $('#dialog')[0];
            dialog.scrollTop = dialog.scrollHeight;
            $('#timing').text(timing(stats));
        });
        history = [...history.slice(-98),user,{role:'assistant',content:result.output}];
    } catch (err) {
        $('#timing').text(err.name === 'AbortError' ? 'Запрос остановлен.' : err.message);
        if (!answer.text()) answer.parent().remove();
        $('#prompt').val(content);
    } finally { controller = null; setBusy(false); }
});
$('#bench').on('click', async () => {
    controller = new AbortController();
    setBusy(true);
    const output = $('#bench-results').empty();
    const measurements = [];
    const prompt = [{role:'user',content:'Ответь ровно одним словом: Привет'}];
    const models = [...new Set([...candidates, $('#model').val()])].filter(model => catalog.includes(model));
    try {
        for (const model of models) {
            const row = $('<p class="mb-1">').text(model + ' · замер…').appendTo(output);
            const runs = [];
            try {
                for (let i=0; i<3; i++)
                    runs.push((await stream(model,prompt,true,controller.signal,()=>{})).stats);
                const median = field => runs.map(run=>run[field]).sort((a,b)=>a-b)[1];
                const stats = {ttfb:median('ttfb'),firstText:median('firstText'),total:median('total')};
                row.text(model + ' · ' + timing(stats) + ' · медиана 3 запросов');
                measurements.push({model, stats});
            } catch (err) {
                row.text(model + ' · ' + (err.name === 'AbortError' ? 'Остановлено' : err.message));
                if (controller.signal.aborted) break;
            }
        }
        if (measurements.length > 1) {
            measurements.sort((a,b)=>a.stats.firstText-b.stats.firstText);
            $('#recommendation').text('По медиане времени до первого текста быстрее ' + measurements[0].model + ' · ' + ms(measurements[0].stats.firstText));
        }
    } finally { controller = null; setBusy(false); }
});

refreshModels();
