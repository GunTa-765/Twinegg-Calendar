const STORAGE_KEY = 'y_cal';
const NAGOYA = { latitude: 35.1815, longitude: 136.9066 };

let cur = new Date();
let selected = dateKey(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
let schedules = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
let holidays = {};
let temps = {};
let metaAbort = null;

function pad(n) {
    return String(n).padStart(2, '0');
}

function dateKey(y, m, d) {
    return `${y}-${m}-${d}`;
}

function isoDate(y, m, d) {
    return `${y}-${pad(m)}-${pad(d)}`;
}

function toDateKeyFromIso(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return dateKey(y, m, d);
}

function tokyoToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { y: get('year'), m: get('month'), d: get('day') };
}

function yesterdayTokyo() {
    const t = tokyoToday();
    const dt = new Date(t.y, t.m - 1, t.d);
    dt.setDate(dt.getDate() - 1);
    return { y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate() };
}

function isBeforeYesterdayInclusive(y, m, d, yest) {
    const a = y * 10000 + m * 100 + d;
    const b = yest.y * 10000 + yest.m * 100 + yest.d;
    return a <= b;
}

function nthMonday(y, monthIndex, n) {
    const first = new Date(y, monthIndex, 1);
    const offset = (1 - first.getDay() + 7) % 7;
    return 1 + offset + (n - 1) * 7;
}

function shunbunDay(y) {
    return Math.floor(20.8431 + 0.242194 * (y - 1851) - Math.floor((y - 1851) / 4));
}

function shubunDay(y) {
    return Math.floor(23.2488 + 0.242194 * (y - 1851) - Math.floor((y - 1851) / 4));
}

function computeJapaneseHolidays(y) {
    const raw = {};
    const add = (m, d, name) => { raw[dateKey(y, m, d)] = name; };

    add(1, 1, '元日');
    add(1, nthMonday(y, 0, 2), '成人の日');
    add(2, 11, '建国記念の日');
    add(2, 23, '天皇誕生日');
    add(3, shunbunDay(y), '春分の日');
    add(4, 29, '昭和の日');
    add(5, 3, '憲法記念日');
    add(5, 4, 'みどりの日');
    add(5, 5, 'こどもの日');
    add(7, nthMonday(y, 6, 3), '海の日');
    add(8, 11, '山の日');
    add(9, nthMonday(y, 8, 3), '敬老の日');
    add(9, shubunDay(y), '秋分の日');
    add(10, nthMonday(y, 9, 2), 'スポーツの日');
    add(11, 3, '文化の日');
    add(11, 23, '勤労感謝の日');

    const isHoliday = (m, d) => Boolean(raw[dateKey(y, m, d)]);
    const lastDay = (m) => new Date(y, m, 0).getDate();

    Object.keys(raw).forEach((k) => {
        const [yy, mm, dd] = k.split('-').map(Number);
        if (new Date(yy, mm - 1, dd).getDay() !== 0) return;
        let m = mm, d = dd + 1;
        while (d > lastDay(m)) {
            d -= lastDay(m);
            m += 1;
            if (m > 12) return;
        }
        while (m <= 12 && isHoliday(m, d)) {
            d += 1;
            if (d > lastDay(m)) {
                d = 1;
                m += 1;
            }
        }
        if (m <= 12 && !isHoliday(m, d)) add(m, d, '振替休日');
    });

    for (let m = 1; m <= 12; m++) {
        for (let d = 2; d < lastDay(m); d++) {
            if (isHoliday(m, d)) continue;
            const prev = d - 1;
            const next = d + 1;
            if (isHoliday(m, prev) && isHoliday(m, next)) add(m, d, '国民の休日');
        }
    }

    return raw;
}

function normalizeHolidayMap(data) {
    const out = {};
    Object.keys(data || {}).forEach((iso) => {
        out[toDateKeyFromIso(iso)] = data[iso];
    });
    return out;
}

async function fetchHolidays(y, signal) {
    const url = `https://holidays-jp.github.io/api/v1/${y}/date.json?t=${Date.now()}`;
    const res = await fetch(url, { signal, cache: 'no-store' });
    if (!res.ok) throw new Error('holiday fetch failed');
    return normalizeHolidayMap(await res.json());
}

async function fetchTemps(y, monthIndex, signal) {
    const yest = yesterdayTokyo();
    const last = new Date(y, monthIndex + 1, 0).getDate();
    const startOk = isBeforeYesterdayInclusive(y, monthIndex + 1, 1, yest);
    if (!startOk && !isBeforeYesterdayInclusive(y, monthIndex + 1, last, yest)) return {};

    const startDay = 1;
    let endDay = last;
    if (y === yest.y && monthIndex + 1 === yest.m) endDay = yest.d;
    else if (!isBeforeYesterdayInclusive(y, monthIndex + 1, last, yest)) return {};

    const start = isoDate(y, monthIndex + 1, startDay);
    const end = isoDate(y, monthIndex + 1, endDay);
    const bust = Date.now();
    const qs = `latitude=${NAGOYA.latitude}&longitude=${NAGOYA.longitude}&daily=temperature_2m_max,temperature_2m_min&timezone=Asia/Tokyo&start_date=${start}&end_date=${end}&t=${bust}`;

    const urls = [
        `https://api.open-meteo.com/v1/forecast?${qs}`,
        `https://archive-api.open-meteo.com/v1/archive?${qs}`
    ];

    let data = null;
    for (const url of urls) {
        try {
            const res = await fetch(url, { signal, cache: 'no-store' });
            if (!res.ok) continue;
            const json = await res.json();
            if (json && json.daily && json.daily.time && json.daily.time.length) {
                data = json;
                break;
            }
        } catch (e) {
            if (e.name === 'AbortError') throw e;
        }
    }
    if (!data) return {};

    const out = {};
    data.daily.time.forEach((iso, i) => {
        const [yy, mm, dd] = iso.split('-').map(Number);
        if (!isBeforeYesterdayInclusive(yy, mm, dd, yest)) return;
        const maxT = data.daily.temperature_2m_max[i];
        const minT = data.daily.temperature_2m_min[i];
        if (maxT == null || minT == null) return;
        out[toDateKeyFromIso(iso)] = { max: Number(maxT).toFixed(1), min: Number(minT).toFixed(1) };
    });
    return out;
}

async function refreshMeta() {
    const y = cur.getFullYear();
    const m = cur.getMonth();
    if (metaAbort) metaAbort.abort();
    metaAbort = new AbortController();
    const { signal } = metaAbort;

    holidays = computeJapaneseHolidays(y);
    draw();

    try {
        const [h, t] = await Promise.all([
            fetchHolidays(y, signal).catch(() => holidays),
            fetchTemps(y, m, signal).catch(() => ({}))
        ]);
        if (signal.aborted) return;
        if (cur.getFullYear() !== y || cur.getMonth() !== m) return;
        holidays = h;
        temps = t;
        draw();
    } catch (e) {
        if (e.name === 'AbortError') return;
    }
}

function tempHtml(k) {
    const t = temps[k];
    if (!t) return '';
    return `<div class="temp-wrap"><span class="temp-max">${t.max}</span><span class="temp-slash">/</span><span class="temp-min">${t.min}</span></div>`;
}

function draw() {
    const y = cur.getFullYear(), m = cur.getMonth();
    document.getElementById('calendar-title').innerText = `${y}年 ${m + 1}月`;
    const first = new Date(y, m, 1).getDay(), last = new Date(y, m + 1, 0).getDate();
    const container = document.getElementById('calendar-days');
    container.innerHTML = '';

    for (let i = 0; i < first; i++) container.innerHTML += '<div class="empty-cell"></div>';

    for (let d = 1; d <= last; d++) {
        const k = dateKey(y, m + 1, d), w = new Date(y, m, d).getDay(), h = holidays[k];
        let c = 'day-normal';
        if (w === 0 || h) c = 'day-sun-holiday';
        else if (w === 6) c = 'day-sat';

        const plansHtml = (schedules[k] || []).map((p) => `<div class="plan-item">${p}</div>`).join('');
        const hHtml = h ? `<span class="holiday-name">${h}</span>` : '';

        // 六曜の文字と色を準備
        const rokuyo = getRokuyo(y, m + 1, d);
        const rokuyoClass = rokuyo === "大安" ? "rokuyo-taian" : rokuyo === "仏滅" ? "rokuyo-butsumetsu" : "rokuyo-normal";
        const rokuyoHtml = `<span class="rokuyo ${rokuyoClass}">${rokuyo}</span>`;

        container.innerHTML += `
            <div class="day-cell ${c} ${selected === k ? 'selected' : ''}" onclick="selectDate('${k}')">
                <div class="cell-top">
                    <span style="font-size:20px; font-weight:bold; color:${w === 0 || h ? 'red' : w === 6 ? 'blue' : ''};">${d}</span>
                    ${rokuyoHtml}
                </div>
                ${hHtml}${tempHtml(k)}${plansHtml}
            </div>`;

    }
    document.getElementById('side-title').innerText = `${selected} の予定`;
    renderList();
}

function render(refresh = true) {
    draw();
    if (refresh) refreshMeta();
}

function changeMonth(v) {
    temps = {};
    cur.setMonth(cur.getMonth() + v);
    render(true);
}

function selectDate(k) {
    selected = k;
    render(false);
}

function goToday() {
    temps = {};
    cur = new Date();
    selected = dateKey(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
    render(true);
}

function renderList() {
    const list = schedules[selected] || [];
    document.getElementById('plan-list').innerHTML = list.length === 0
        ? "<p style='color:#999;font-size:13px;'>予定はありません</p>"
        : list.map((p, i) => `<div class="list-item"><span>${p}</span><button style="color:red;border:none;background:none;cursor:pointer;font-weight:bold;" onclick="delPlan(${i})">×</button></div>`).join('');
}

function addPlan() {
    const input = document.getElementById('plan-input'), t = input.value.trim();
    if (!t) return;
    if (!schedules[selected]) schedules[selected] = [];
    schedules[selected].push(t);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
    input.value = '';
    render(false);
}

function delPlan(i) {
    schedules[selected].splice(i, 1);
    if (schedules[selected].length === 0) delete schedules[selected];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
    render(false);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') render(true);
});

render(true);

/**
 * 六曜自動計算関数（一番下に貼り付けてください）
 */
function getRokuyo(year, month, day) {
    const rokuyoList = ["大安", "赤口", "先勝", "友引", "先負", "仏滅"];
    const list2026 = "0,2,2,3,5,0,1,3,4,5,1,2";
    const list2027 = "3,5,5,0,1,3,4,5,0,1,3,4";
    
    let csv = list2026;
    if (year === 2027) csv = list2027;
    
    const offsets = csv.split(",");
    const yearOffset = Number(offsets[month - 1] || 0);
    const index = (day + yearOffset) % 6;
    
    return rokuyoList[index];
}

// --- script.js の一番下にそのまま追記してください ---

let pickerYear = cur.getFullYear(); // 選択画面内で管理する「年」

/**
 * 年月選択画面の表示・非表示を切り替える
 */
function toggleYearMonthPicker() {
    const picker = document.getElementById('ym-picker');
    if (picker.style.display === 'none') {
        pickerYear = cur.getFullYear(); // 現在カレンダーが表示している年に合わせる
        document.getElementById('picker-year-title').innerText = `${pickerYear}年`;
        picker.style.display = 'block';
    } else {
        picker.style.display = 'none';
    }
}

/**
 * 選択画面の中の「年」を切り替える（◀ ▶ ボタン用）
 */
function changePickerYear(v) {
    pickerYear += v;
    document.getElementById('picker-year-title').innerText = `${pickerYear}年`;
}

/**
 * 月がクリックされたらカレンダーをその年月にジャンプさせる
 */
function selectPickerMonth(m) {
    temps = {}; // 気温データをリセット
    cur.setFullYear(pickerYear);
    cur.setMonth(m - 1);
    
    // 選択日もその年月の1日に合わせておくと親切です
    selected = dateKey(pickerYear, m, 1);
    
    toggleYearMonthPicker(); // 閉じる
    render(true);            // カレンダーを再描画
}

/**
 * 登録されているすべての予定をCSVファイルとしてエクスポートする
 */
function exportToCSV() {
    // 登録されている予定（schedules）が空っぽの場合は処理を中断
    if (Object.keys(schedules).length === 0) {
        alert("エクスポートする予定がありません。");
        return;
    }

    // CSVのデータを格納する配列
    let csvRows = [];

    // 日付キー（例: "2020-3-14"）をすべて取得して、古い順に並び替える
    const sortedKeys = Object.keys(schedules).sort((a, b) => {
        const [yA, mA, dA] = a.split('-').map(Number);
        const [yB, mB, dB] = b.split('-').map(Number);
        return new Date(yA, mA - 1, dA) - new Date(yB, mB - 1, dB);
    });

    // 日付ごとに予定をCSVの行フォーマットに変換
    for (const key of sortedKeys) {
        const [year, month, day] = key.split('-');
        
        // 2桁に揃える（例: 3月 ➔ 03月、7日 ➔ 07日）
        const yStr = `${year}年`;
        const mStr = `${String(month).padStart(2, '0')}月`;
        const dStr = `${String(day).padStart(2, '0')}日`;
        
        // その日の予定リストをループして1件ずつ行を作る
        for (const plan of schedules[key]) {
            // 予定内容にダブルクォーテーションが含まれている場合のバグ回避（エスケープ処理）
            const cleanPlan = plan.replace(/"/g, '""');
            // 「2020年,03月,14日,"予定内容"」の形にする
            csvRows.push(`${yStr},${mStr},${dStr},"${cleanPlan}"`);
        }
    }

    // CSVテキストを作成（Excel等で文字化けしないよう、改行コードは \r\n に指定）
    const csvString = csvRows.join('\r\n');

    // 日本語（UTF-8）の文字化けを防ぐための「BOM」というサインを先頭に付与
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvString], { type: 'text/csv;charset=utf-8;' });
    
    // ダウンロード用のリンクを一時的に作って自動クリックさせる
    const link = document.createElement("a");
    if (link.download !== undefined) {
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        // ファイル名は「calendar_plans.csv」になります
        link.setAttribute("download", "calendar_plans.csv");
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

/**
 * CSVファイルから予定を読み込んでインポートする関数（システムバグ回避版）
 */
function importFromCSV(input) {
    const file = input.files[0]; // [0]を明示して安全に取得
    if (!file) return;

    const reader = new FileReader();
    
    reader.onload = function(e) {
        const csvData = e.target.result;
        console.log("CSVファイルのインポートを開始します...");

        let addCount = 0;
        
        // システムバグを回避するため、特殊記号を使わず「改行」でシンプルに1行ずつ分解します
        const lines = csvData.split("\n");

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            // Windows形式の改行コード（\(\r\)）が残っている場合は綺麗に消去
            line = line.replace("\(\r\)", "");
            if (!line) continue;

            const parts = line.split(",");
            if (parts.length < 4) continue;

            // 「年」「月」「日」から文字を取り除いて数値にする
            const y = parseInt(parts[0].replace("年", ""), 10);
            const m = parseInt(parts[1].replace("月", ""), 10);
            const d = parseInt(parts[2].replace("日", ""), 10);

            // 予定内容を取り出し、前後のダブルクォーテーションを消去
            let rawPlanText = parts.slice(3).join(",").trim();
            if (rawPlanText.startsWith('"') && rawPlanText.endsWith('"')) {
                rawPlanText = rawPlanText.slice(1, -1);
            }

            if (!isNaN(y) && !isNaN(m) && !isNaN(d)) {
                const key = `${y}-${m}-${d}`;

                if (!schedules[key]) {
                    schedules[key] = [];
                }

                // スラッシュ「 / 」で区切られている場合は個別に分解する（バグの起きない安全な記述）
                const individualPlans = rawPlanText.split(" / ");

                for (let j = 0; j < individualPlans.length; j++) {
                    let plan = individualPlans[j].trim();
                    if (!plan) continue;

                    if (!schedules[key].includes(plan)) {
                        schedules[key].push(plan);
                        addCount++;
                    }
                }
            }
        }

        // ストレージへ上書き保存（STORAGE_KEY変数をそのまま使用）
        localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
        
        alert("インポートが成功しました！\n新しく " + addCount + " 件の予定を登録しました。");
        
        input.value = "";
        
        // カレンダー画面を再描画して最新状態にする
        if (typeof render === "function") {
            render(false);
        }
    };

    reader.readAsText(file, "UTF-8");
}

// --- script.js の一番下にそのまま追記してください ---

/**
 * スマホ用：予定追加画面（モーダル）を開く
 */
function openMobileAddModal() {
    document.getElementById('mobile-plan-input').value = '';
    document.getElementById('mobile-add-modal').style.display = 'flex';
    document.getElementById('mobile-plan-input').focus();
}

/**
 * スマホ用：予定追加画面（モーダル）を閉じる
 */
function closeMobileAddModal() {
    document.getElementById('mobile-add-modal').style.display = 'none';
}

/**
 * スマホ用：設定画面（モーダル）の表示切り替え
 */
function toggleMobileSettings() {
    const modal = document.getElementById('mobile-settings-modal');
    if (modal.style.display === 'none') {
        modal.style.display = 'flex';
    } else {
        modal.style.display = 'none';
    }
}

/**
 * スマホ用：モーダルから予定を追加する処理
 */
function addPlanMobile() {
    const input = document.getElementById('mobile-plan-input');
    const t = input.value.trim();
    if (!t) return;
    
    // 既存のグローバル変数「schedules」と「selected」を使って保存
    if (!schedules[selected]) schedules[selected] = [];
    schedules[selected].push(t);
    
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schedules));
    input.value = '';
    
    closeMobileAddModal(); // モーダルを閉じる
    render(false);         // カレンダーと下部予定リストをリフレッシュ
}
