// ==UserScript==
// @name         JPDB show all occurences
// @description  Shows all occurences of words in your decks on the vocabulary page
// @namespace    http://karols.github.io
// @author       vytah
// @version      2025-03-07
// @match        https://jpdb.io/settings
// @match        https://jpdb.io/vocabulary/*
// @grant        GM_xmlhttpRequest
// @connect      jpdb.io
// ==/UserScript==

/*
    USER'S MANUAL:
    1. Install the userscript
    2. Visit https://jpdb.io/settings
    3. Click "Fetch decks into cache"
    4. Wait for the fetching to complete
    5. Vocabulary pages should now show word occurences in all your decks
    6. To update the data after you've made modifications to you decks or their content, perform steps 2-5 again
*/
await (async function() {
    'use strict';

    const findApiKey = () => {
        let useNext = false;
        for(let e of document.getElementsByTagName("td")) {
            if (useNext) return e.innerHTML;
            if (e.innerHTML === 'API key') useNext = true;
        }
        return undefined;
    }
    const NEEDS_ESCAPING = /[<>&"']/;
    const escapeHtml = (str) => {
        return !(NEEDS_ESCAPING.test(str)) ? str : str.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    }
    const time = (f, name) => {
        let start = Date.now();
        let result = f();
        let end = Date.now();
        //console.log(`TIME: ${name??''} ${end-start} ms`);
        return result;
    }

    async function jpdbRequest(url, body, apiKey) {
        let response = await GM.xmlHttpRequest({
            url:"https://jpdb.io/api/v1/" + url,
            headers: {
                "Authorization": "Bearer " + apiKey,
                "Content-Type": "application/json"
            },
            method: "POST",
            responseType: 'json',
            data: JSON.stringify(body),
        }).catch(e => console.error(e));
        response = response.response;
        //console.log(response);
        return response;
    }

    async function fetchAllDecks(apiKey) {
        console.log("Fetching deck list");
        let response = await jpdbRequest("list-user-decks", {fields: ["name", "id"]}, apiKey);
        return response.decks.map(it => ({name:it[0], id:it[1]}));
    }
    async function fetchDeck(deckId, apiKey) {
        console.log("Fetching deck " + deckId);
        let response = await jpdbRequest("deck/list-vocabulary", {id:deckId, fetch_occurences: true}, apiKey);
        let vocabs = [];
        for (let i = 0; i < response.vocabulary.length; i++) {
            let vocab = {
                vid: response.vocabulary[i][0],
                sid: response.vocabulary[i][1],
                occurences: response.occurences[i],
            };
            vocabs.push(vocab);
        }
        return vocabs;
    }
    async function fetchSpellings(wordSet, apiKey) {
        console.log("Fetching spellings for " + wordSet.size + " words");
        let ids = [];
        for (let word of wordSet) {
            ids.push(word.split('/').map(it=>+it));
        }
        // console.log(ids);
        let response = await jpdbRequest("lookup-vocabulary", {list:ids, fields:["spelling"]}, apiKey);
        let map = new Map();
        for (let i = 0; i < response.vocabulary_info.length; i++) {
            let spell = response.vocabulary_info[i][0];
            let id = ids[i][1];
            map.set(id, spell);
        }
        return map;
    }

    const DATA_FORMAT_1_UUID = "2f0169ea-593c-423f-8496-255f98f73df5";
    function compressDecks_format1(decks, spellMap) {
        let words = [];
        let wordMap = new Map();
        let compressedDecks = [];
        for (let deck of decks) {
            let compressed = [];
            for (let word of deck.vocabulary) {
                if (!spellMap.has(word.sid)) continue;
                let vsid = `${word.vid}/${word.sid}`;
                let wid = wordMap.get(vsid);
                if (wid == undefined) {
                    wid = words.length/2;
                    wordMap.set(vsid, wid);
                    words.push(word.vid.toString(36));
                    words.push(spellMap.get(word.sid));
                }
                compressed.push(word.occurences === 1 ? wid : [wid, word.occurences]);
            }
            compressedDecks.push({name: deck.name, id:deck.id, vocabulary: compressed});
        }
        return ({
            format: DATA_FORMAT_1_UUID,
            decks: compressedDecks,
            words: words,
            lastFetched: new Date().toString()
        })
    }
    function trimDecks_format1(data, currentVid) {
        let currentVidText = currentVid.toString(36);
        let trimmedDecks = [];
        for (let deck of data.decks) {
            let trimmedVocabulary = [];
            for (let word of deck.vocabulary) {
                let wid = typeof word === "number" ? word : word[0];
                if (currentVidText === data.words[wid * 2]){
                    trimmedVocabulary.push({
                        spelling: data.words[wid * 2 + 1],
                        occurences: typeof word === "number" ? 1 : word[1]
                    })
                }
            }
            trimmedDecks.push({
                name: deck.name,
                id: deck.id,
                trimmedVocabulary: trimmedVocabulary
            });
        }
        return trimmedDecks;
    }

    function trimDecks_formatAuto(data, currentVid) {
        if (data?.format === DATA_FORMAT_1_UUID) {
            return trimDecks_format1(data, currentVid);
        }
        console.error("Unknown format: " + data?.format);
        return [];
    }
    function hasSupportedFormat(data) {
        return [DATA_FORMAT_1_UUID].includes(data?.format);
    }

    if (document.URL === "https://jpdb.io/settings") {
        let apiKey = findApiKey();
        console.log(apiKey);
        let data = undefined;
        try {
            let stored = localStorage.getItem('vv_decks');
            if (stored) {
                data = JSON.parse(stored);
                if (data?.format !== DATA_FORMAT_1_UUID) {
                    console.error("Incompatible deck format in cache: " + data?.format);
                    data = undefined;
                }
            }
        } catch (e) {
            console.error("Damaged parsed decks!");
        }
        document.vv_fetchAllDecks = async () => {
            let progress = document.getElementById("vv_fetch_progress");
            progress.innerHTML = `Fetching decks`;
            let decks = await fetchAllDecks(apiKey);
            console.log(decks);
            let wordSet = new Set();
            let ix = 1;
            for (let deck of decks) {
                progress.innerHTML = `Fetching deck ${ix} of ${decks.length}`;
                let vocab = await fetchDeck(deck.id, apiKey);
                deck.vocabulary = vocab;
                for(let word of vocab) {
                    wordSet.add(`${word.vid}/${word.sid}`);
                }
                ix += 1;
            }
            progress.innerHTML = "Fetching word spellings";
            let spellMap = await fetchSpellings(wordSet, apiKey);
            progress.innerHTML = "Compressing data";
            let deckData = compressDecks_format1(decks, spellMap);
            localStorage.setItem('vv_decks', JSON.stringify(deckData));
            progress.innerHTML = "Last time fetched: " + deckData.lastFetched;
        }
        try {
            let header = document.getElementsByTagName("H4")[0];
            let last_date = data?.lastFetched;
            if (last_date) last_date = "Last time fetched: " + last_date; else last_date = "No decks in cache";
            console.log(last_date);
            header.outerHTML += `
<form>
<h6 style="margin-top: 0;">Show all occurences on vocabulary pages</h6>
<div><div class="subsection-header">
<span id="vv_fetch_progress">${last_date}</span>
<br>
<input type="button" onclick="document.vv_fetchAllDecks()" class="outline" style="font-weight: bold;" value="Fetch decks into cache">
</div></div>
</form>
            `;
        } catch (e) {
            console.error("Failed to inject UI. You can fetch decks manually by executing in the console:\ndocument.vv_fetchAllDecks()");
        }
    }
    if (document.URL.startsWith('https://jpdb.io/vocabulary/')) {
        let currentVid = +document.URL.split('/')[4];
        if (!Number.isInteger(currentVid) || currentVid < 0) {
            console.log("Invalid word ID in URL")
            return;
        }
        let siblingDiv = undefined;
        if (document.URL.includes("/used-in")) {
            siblingDiv = document.getElementsByClassName('vocabulary')[0];
        } else {
            try {
                siblingDiv = document.getElementsByClassName('view-conjugations-link')[0].parentElement;
            } catch (e) {
                siblingDiv = document.getElementsByClassName('subsection-pitch-accent')[0].parentElement.parentElement.parentElement;
            }
        }
        if (!siblingDiv) {
            console.log("No target div found")
            return;
        }
        let data = time(()=>{
            let stored = localStorage.getItem('vv_decks');
            return stored ? JSON.parse(stored) : stored;
        }, "parse");
        if (!data) {
            console.error("Visit https://jpdb.io/settings to fetch decks")
            return;
        }
        if (!hasSupportedFormat(data)) {
            console.error("Invalid cached decks format. Visit https://jpdb.io/settings to fetch decks again")
            return;
        }
        let decks = time(() => trimDecks_formatAuto(data, currentVid), "trim decks");
        let spellingsList = time(() => {
            let spellings = new Map();
            for (let deck of decks) {
                for (let word of deck.trimmedVocabulary) {
                    spellings.set(word.spelling, (spellings.get(word.spelling) ?? 0) + word.occurences);
                }
            }
            return [...spellings.entries()];
        }, "build spellings map");
        if (spellingsList.length === 0) {
            console.log("Word not in any deck");
            return;
        }
        spellingsList.sort((a,b) => b[1] - a[1]);
        const nudgeFactor = (i) => i < 0 ? 1e8 : 1e8 + (spellingsList.length - i);
        let rows = [];
        time(() =>{
            for (let deck of decks) {
                if (deck.trimmedVocabulary.length === 0) continue;
                let cells = Array(spellingsList.length);
                cells.fill({html: `<td style="padding:0;border:none;padding-left:1em;text-align:right"></td>`});
                let totalInThisDeck = 0;
                let totalInThisDeckNudged = 0;
                for (let word of deck.trimmedVocabulary) {
                    let index = spellingsList.findIndex(it => it[0] === word.spelling);
                    totalInThisDeck += word.occurences;
                    totalInThisDeckNudged += word.occurences * nudgeFactor(index);
                    let cell = {
                        occurences: word.occurences,
                        html: `
<td style="padding:0;border:none;padding-left:1em;text-align:right">
<b>${word.occurences}×</b>&nbsp;<a class="plain" href="https://jpdb.io/vocabulary/${currentVid}/${encodeURI(word.spelling)}#a">${word.spelling}</a>
</td>`
                    };
                    if (index < 0) {
                        cells.push(cell);
                    } else {
                        cells[index] = cell;
                    }
                }
                if (totalInThisDeck > 0) {
                    rows.push({
                        occurences: totalInThisDeck,
                        nudgedOccurences: totalInThisDeckNudged,
                        html: `<tr>
<td style="padding:0;border:none"><a href="https://jpdb.io/deck?id=${deck.id}">${escapeHtml(deck.name)}</a></td>
${cells.map(it=>it.html).join('')}
</tr>`
                    });
                }
            }
        }, "build table");
        if (rows.length) {
            rows.sort((a,b) => b.nudgedOccurences - a.nudgedOccurences);
            let total = rows.map(it => it.occurences).reduce((a, b) => a + b);
            console.log("Word found in " + rows.length + " decks");
            siblingDiv.outerHTML += `
            <div><table>
            ${rows.map(it=>it.html).join('')}
            <tr><td style="border:none">Total: <b>${total}</b></td>
            ${spellingsList.map(s => s[1] ? `
                <td class="greyed-out" style="padding:0;border:none;padding-left:1em;text-align:right">
                <b>${s[1]}×</b>&nbsp;<a class="plain" href="https://jpdb.io/vocabulary/${currentVid}/${encodeURI(s[0])}#a">${s[0]}</a>
                </td>
            ` : `<td class="greyed-out" style="padding:0;border:none"></td>`).join('')}
            </tr></table></div>`;
        } else {
            console.log("Word not in any deck");
        }


    }

})();
