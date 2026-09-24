/* ===== MD EDITOR — BACKLOG.JS =====
 * Modo mapa: épicos, features e itens de backlog como mapa mental.
 *
 * Cada item é uma nota .md com frontmatter:
 *   tipo: epico | feature | item
 *   id: FT-03
 *   pai: "[[Nota pai]]"
 *   status: rascunho | pronto | em andamento | concluído | bloqueado
 *   depende: ["[[Outra nota]]"]     (também: bloqueia, relacionado)
 *
 * A hierarquia sai do campo "pai"; as relações, dos demais campos. O
 * preenchimento compara as seções (## títulos) da nota com o modelo do tipo.
 */

(() => {
    'use strict';

    const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
    const ROOT = '__root__';
    const ORPHANS = '__orphans__';

    const TYPES = {
        epico: {
            label: 'Épico',
            newLabel: 'Novo épico',
            thisLabel: 'deste épico',
            prefix: 'EP',
            child: 'feature',
            sections: [
                ['Objetivo'],
                ['Problema', 'Contexto'],
                ['Métricas de sucesso', 'Métricas', 'Indicadores'],
                ['Escopo'],
                ['Fora de escopo']
            ],
            hints: [
                'Que resultado de negócio este épico entrega?',
                'Que dor ou oportunidade motiva o épico?',
                'Como saberemos que deu certo? Números e prazos.',
                'O que entra.',
                'O que fica de fora, de propósito.'
            ]
        },
        feature: {
            label: 'Feature',
            newLabel: 'Nova feature',
            thisLabel: 'desta feature',
            prefix: 'FT',
            child: 'item',
            sections: [
                ['Descrição', 'Resumo'],
                ['Valor para o usuário', 'Valor'],
                ['Critérios de aceite', 'Critérios de aceitação'],
                ['Dependências e riscos', 'Riscos', 'Dependências']
            ],
            hints: [
                'O que a feature faz, em duas ou três frases.',
                'Que problema do usuário ela resolve?',
                'Condições verificáveis para considerar pronta.',
                'O que precisa existir antes; o que pode dar errado.'
            ]
        },
        item: {
            label: 'Item',
            newLabel: 'Novo item',
            thisLabel: 'deste item',
            prefix: 'IT',
            child: null,
            sections: [
                ['História', 'User story', 'Descrição'],
                ['Critérios de aceite', 'Critérios de aceitação'],
                ['Notas técnicas', 'Notas']
            ],
            hints: [
                'Como <persona>, quero <ação>, para <benefício>.',
                'Cada critério deve ser verificável por um teste.',
                'Decisões, pontos de atenção, links.'
            ]
        }
    };

    const TYPE_ALIASES = {
        epico: 'epico', epic: 'epico',
        feature: 'feature', funcionalidade: 'feature',
        item: 'item', historia: 'item', story: 'item', userstory: 'item',
        tarefa: 'item', task: 'item', pbi: 'item', backlogitem: 'item'
    };

    const FIELD_ALIASES = {
        tipo: 'type', type: 'type',
        pai: 'parent', parent: 'parent', epico: 'parent', epic: 'parent', feature: 'parent',
        status: 'status', estado: 'status',
        id: 'id', codigo: 'id', chave: 'id', key: 'id',
        titulo: 'title', title: 'title',
        responsavel: 'owner', owner: 'owner', dono: 'owner',
        estimativa: 'estimate', estimate: 'estimate', pontos: 'estimate', points: 'estimate',
        depende: 'depends', dependede: 'depends', dependencias: 'depends', dependson: 'depends', dependencies: 'depends',
        bloqueia: 'blocks', blocks: 'blocks',
        relacionado: 'related', relacionados: 'related', related: 'related', relacionada: 'related', relacionadas: 'related'
    };

    const STATUS = {
        rascunho: { label: 'Rascunho', aliases: ['rascunho', 'draft', 'ideia', 'novo', 'todo', 'afazer', 'backlog'] },
        pronto: { label: 'Pronto', aliases: ['pronto', 'ready', 'refinado', 'aprovado'] },
        andamento: { label: 'Em andamento', aliases: ['emandamento', 'andamento', 'fazendo', 'doing', 'inprogress', 'wip', 'desenvolvimento', 'emdesenvolvimento'] },
        concluido: { label: 'Concluído', aliases: ['concluido', 'feito', 'done', 'entregue', 'finalizado', 'fechado', 'closed'] },
        bloqueado: { label: 'Bloqueado', aliases: ['bloqueado', 'blocked', 'impedido'] }
    };
    const STATUS_WRITE = {
        rascunho: 'rascunho', pronto: 'pronto', andamento: 'em andamento', concluido: 'concluído', bloqueado: 'bloqueado'
    };

    const RELATIONS = {
        depends: { label: 'depende de', inverse: 'dependents' },
        blocks: { label: 'bloqueia', inverse: 'blockedBy' },
        related: { label: 'relacionado a', inverse: 'related' }
    };

    // Geometria do mapa (px)
    const COL = 300;
    const NODE_W = 236;
    const NODE_H = 80;
    const GAP = 16;

    function create(api) {
        const $ = (sel) => document.querySelector(sel);
        const esc = api.escapeHtml;

        const view = $('#backlog-view');
        const main = $('#main');
        const canvas = $('#bl-canvas');
        const stage = $('#bl-stage');
        const edgesEl = $('#bl-edges');
        const nodesEl = $('#bl-nodes');
        const detail = $('#bl-detail');
        const crumbs = $('#bl-crumbs');
        const search = $('#bl-search');
        const empty = $('#bl-empty');
        const relToggle = $('#bl-relations');
        const btnMap = $('#btn-backlog');

        const state = {
            dir: null,
            focus: ROOT,
            selected: ROOT,
            collapsed: new Set(),
            showRelations: true,
            query: '',
            view: { x: 40, y: 40, k: 1 },
            fitPending: true
        };
        let model = null;
        let pos = new Map();       // caminho → { x, y } da última renderização
        let order = [];            // nós visíveis em ordem de layout
        let detailGen = 0;

        // ── Parsing ────────────────────────────────────

        function normKey(value) {
            return api.foldText(String(value || '')).replace(/[^a-z0-9]/g, '');
        }

        function asText(value) {
            return (Array.isArray(value) ? value.join(', ') : String(value || '')).trim();
        }

        // "[[A]], [[B|b]]" ou ["[[A]]"] ou "A, B" → ["A", "B"]
        function linkTargets(value) {
            const raw = asText(value);
            const out = [];
            const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
            let m;
            while ((m = re.exec(raw)) !== null) out.push(api.parseLinkTarget(m[1]).note);
            if (!out.length && raw) raw.split(',').map(s => s.trim()).filter(Boolean).forEach(s => out.push(s));
            return out;
        }

        function statusKey(value) {
            const key = normKey(value);
            if (!key) return '';
            for (const [name, def] of Object.entries(STATUS)) {
                if (def.aliases.includes(key)) return name;
            }
            return 'outro';
        }

        // Seções ## da nota com o texto de cada uma (até o próximo título de
        // nível igual ou maior). Blocos de código não contam como títulos.
        function parseSections(body) {
            const lines = body.split(/\r?\n/);
            const inFence = api.fenceMask(lines);
            const heads = [];
            lines.forEach((line, i) => {
                if (inFence[i]) return;
                const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
                if (m) heads.push({ i, level: m[1].length, title: m[2] });
            });
            return heads.map((h, n) => {
                let end = lines.length;
                for (let k = n + 1; k < heads.length; k++) {
                    if (heads[k].level <= h.level) { end = heads[k].i; break; }
                }
                return { title: h.title, slug: api.slugify(h.title), content: lines.slice(h.i + 1, end).join('\n') };
            });
        }

        // Comentários de modelo (<!-- -->) e itens de lista vazios não contam.
        function hasContent(text) {
            return text
                .replace(/<!--[\s\S]*?-->/g, '')
                .split('\n')
                .some(line => {
                    const t = line.trim();
                    return t && !/^([-*+]|\d+[.)])?\s*(\[[ xX]?\])?\s*$/.test(t) && t !== '>';
                });
        }

        function buildModel() {
            const nodes = new Map();
            for (const path of api.listNotes()) {
                const text = api.getText(path);
                if (text == null) continue;
                const { meta, body } = api.splitFrontmatter(text);
                if (!meta) continue;
                const fields = {};
                for (const { key, value } of meta) {
                    const field = FIELD_ALIASES[normKey(key)];
                    if (field && !(field in fields)) fields[field] = value;
                }
                const type = TYPE_ALIASES[normKey(asText(fields.type))];
                if (!type) continue;
                nodes.set(path, {
                    path,
                    type,
                    title: asText(fields.title) || api.noteTitle(path),
                    id: asText(fields.id),
                    status: asText(fields.status),
                    statusKey: statusKey(asText(fields.status)),
                    owner: asText(fields.owner),
                    estimate: asText(fields.estimate),
                    parentRaw: linkTargets(fields.parent)[0] || '',
                    relRaw: {
                        depends: linkTargets(fields.depends),
                        blocks: linkTargets(fields.blocks),
                        related: linkTargets(fields.related)
                    },
                    sections: parseSections(body),
                    parent: null,
                    children: [],
                    rel: { depends: [], blocks: [], related: [] },
                    inverse: { dependents: [], blockedBy: [], related: [] },
                    issues: []
                });
            }

            // Hierarquia
            for (const node of nodes.values()) {
                if (!node.parentRaw) continue;
                const target = api.resolveNotePath(node.parentRaw);
                if (target && nodes.has(target) && target !== node.path) {
                    node.parent = nodes.get(target);
                } else {
                    node.issues.push(`pai não encontrado: ${node.parentRaw}`);
                }
            }
            // Ciclos na hierarquia: corta o vínculo do nó que fecha o ciclo.
            for (const node of nodes.values()) {
                const seen = new Set([node]);
                for (let p = node.parent; p; p = p.parent) {
                    if (seen.has(p)) {
                        node.issues.push('ciclo na hierarquia');
                        node.parent = null;
                        break;
                    }
                    seen.add(p);
                }
            }
            for (const node of nodes.values()) {
                if (node.parent) node.parent.children.push(node);
                else if (node.type !== 'epico' && !node.parentRaw) node.issues.push('sem pai');
            }

            // Relações e inversas
            for (const node of nodes.values()) {
                for (const kind of Object.keys(RELATIONS)) {
                    for (const raw of node.relRaw[kind]) {
                        const target = api.resolveNotePath(raw);
                        node.rel[kind].push({ raw, path: target });
                        if (!target) {
                            node.issues.push(`relação quebrada: ${raw}`);
                        } else if (nodes.has(target) && target !== node.path) {
                            const inv = nodes.get(target).inverse[RELATIONS[kind].inverse];
                            if (!inv.includes(node.path)) inv.push(node.path);
                        }
                    }
                }
            }

            // Preenchimento
            for (const node of nodes.values()) {
                const def = TYPES[node.type];
                const checks = def.sections.map(aliases => {
                    const wanted = aliases.map(a => api.slugify(a));
                    const section = node.sections.find(s => wanted.some(w => s.slug === w || s.slug.startsWith(w + '-')));
                    return {
                        label: aliases[0],
                        ok: !!section && hasContent(section.content),
                        state: !section ? 'ausente' : (hasContent(section.content) ? 'ok' : 'vazia')
                    };
                });
                if (node.type !== 'epico') {
                    checks.unshift({ label: 'Pai definido', ok: !!node.parent, state: node.parent ? 'ok' : 'ausente' });
                }
                checks.push({ label: 'Status definido', ok: !!node.status, state: node.status ? 'ok' : 'ausente' });
                const done = checks.filter(c => c.ok).length;
                node.fill = { checks, done, total: checks.length, ratio: done / checks.length };
                if (node.fill.ratio < 0.5) node.issues.push('documentação incompleta');
            }

            const byTitle = (a, b) => (a.id || a.title).localeCompare(b.id || b.title, 'pt-BR', { numeric: true, sensitivity: 'base' });
            for (const node of nodes.values()) node.children.sort(byTitle);

            const tops = [...nodes.values()].filter(n => !n.parent).sort(byTitle);
            const root = { path: ROOT, type: 'root', title: 'Backlog', children: tops.filter(n => n.type === 'epico'), parent: null };
            const orphans = tops.filter(n => n.type !== 'epico');
            if (orphans.length) {
                const group = { path: ORPHANS, type: 'group', title: 'Sem pai', children: orphans, parent: root };
                root.children.push(group);
            }

            // Progresso: folhas concluídas sob cada nó.
            const rollup = (node) => {
                if (!node.children.length) return { total: 1, done: node.statusKey === 'concluido' ? 1 : 0 };
                const sum = { total: 0, done: 0 };
                for (const child of node.children) {
                    const r = rollup(child);
                    sum.total += r.total;
                    sum.done += r.done;
                }
                node.progress = sum;
                return sum;
            };
            rollup(root);

            return { nodes, root, orphans };
        }

        function nodeByPath(path) {
            if (!model) return null;
            if (path === ROOT) return model.root;
            if (path === ORPHANS) return model.root.children.find(c => c.path === ORPHANS) || null;
            return model.nodes.get(path) || null;
        }

        // Pai na árvore do mapa: épicos sem pai ficam sob a raiz; features e
        // itens sem pai, sob o grupo "Sem pai".
        function treeParent(node) {
            if (!node || node === model.root) return null;
            if (node.type === 'group') return model.root;
            if (node.parent) return node.parent;
            return node.type === 'epico' ? model.root : nodeByPath(ORPHANS);
        }

        // Caminho da raiz virtual até o nó (inclusive).
        function ancestry(node) {
            const chain = [];
            for (let n = node; n; n = treeParent(n)) chain.unshift(n);
            return chain;
        }

        function isInside(node, ancestor) {
            return ancestry(node).includes(ancestor);
        }

        // ── Persistência ───────────────────────────────

        function loadState() {
            state.dir = api.dirName();
            const saved = api.loadJson('backlog:' + state.dir, null) || {};
            state.collapsed = new Set(saved.collapsed || []);
            state.focus = saved.focus || ROOT;
            state.showRelations = saved.showRelations !== false;
            state.selected = state.focus;
            state.fitPending = true;
            relToggle.checked = state.showRelations;
        }

        function saveState() {
            api.saveJson('backlog:' + state.dir, {
                collapsed: [...state.collapsed],
                focus: state.focus,
                showRelations: state.showRelations
            });
        }

        // ── Layout e desenho ───────────────────────────

        function matchesQuery(node) {
            if (!state.query) return false;
            return api.foldText(`${node.title} ${node.id || ''}`).includes(api.foldText(state.query));
        }

        function render() {
            if (!model) return;
            let root = nodeByPath(state.focus);
            if (!root) {
                state.focus = ROOT;
                root = model.root;
            }

            // Busca: abre os ancestrais de quem casa.
            const forced = new Set();
            const matched = new Set();
            if (state.query) {
                for (const node of model.nodes.values()) {
                    if (!matchesQuery(node)) continue;
                    matched.add(node.path);
                    for (const a of ancestry(node)) forced.add(a.path);
                }
            }
            const expanded = (n) => n.children.length > 0 && (!state.collapsed.has(n.path) || forced.has(n.path));

            pos = new Map();
            order = [];
            let cursor = 0;
            const place = (node, depth) => {
                const kids = expanded(node) ? node.children : [];
                kids.forEach(k => place(k, depth + 1));
                let y;
                if (!kids.length) {
                    y = cursor;
                    cursor += NODE_H + GAP;
                } else {
                    y = (pos.get(kids[0].path).y + pos.get(kids[kids.length - 1].path).y) / 2;
                }
                pos.set(node.path, { x: depth * COL, y, node });
            };
            place(root, 0);
            // Ordem de leitura (de cima para baixo, pai antes dos filhos)
            const walk = (node) => {
                order.push(node);
                if (expanded(node)) node.children.forEach(walk);
            };
            walk(root);

            nodesEl.innerHTML = order.map(n => nodeHtml(n, pos.get(n.path), {
                expanded: expanded(n),
                match: matched.has(n.path),
                dim: !!state.query && !matched.has(n.path)
            })).join('');

            refreshHighlight();
            renderCrumbs(root);
            empty.classList.toggle('hidden', model.nodes.size > 0);
            if (state.fitPending) {
                state.fitPending = false;
                fit();
            } else {
                applyTransform();
            }
        }

        // Atualiza seleção e destaques sem recriar os nós (recriar no meio de
        // um duplo clique faria o navegador perder o evento).
        function refreshHighlight() {
            const selected = nodeByPath(state.selected);
            const related = relatedPaths(selected);
            const focusMode = selected && selected.fill && related.size > 0;
            nodesEl.querySelectorAll('.bl-node').forEach(el => {
                const path = el.dataset.path;
                el.classList.toggle('selected', !!selected && selected.path === path);
                el.classList.toggle('related', related.has(path));
                el.classList.toggle('faded', !!focusMode && !related.has(path) && selected.path !== path);
            });
            drawEdges(nodeByPath(state.focus) || model.root, selected);
        }

        // Nós ligados ao selecionado (pai, filhos e relações), para destacar.
        function relatedPaths(node) {
            const set = new Set();
            if (!node || !node.fill) return set;
            if (node.parent) set.add(node.parent.path);
            node.children.forEach(c => set.add(c.path));
            for (const kind of Object.keys(RELATIONS)) node.rel[kind].forEach(r => r.path && set.add(r.path));
            for (const list of Object.values(node.inverse)) list.forEach(p => set.add(p));
            return set;
        }

        function nodeHtml(n, p, flags) {
            const cls = ['bl-node', 'type-' + n.type];
            if (n.statusKey) cls.push('status-' + n.statusKey);
            if (flags.match) cls.push('match');
            if (flags.dim) cls.push('dim');
            const style = `left:${p.x}px;top:${p.y}px;width:${NODE_W}px;height:${NODE_H}px`;
            const toggle = n.children.length
                ? `<button class="bl-kids" data-toggle="${esc(n.path)}" title="${flags.expanded ? 'Recolher' : 'Expandir'}">${flags.expanded ? '−' : n.children.length}</button>`
                : '';

            if (n.type === 'root' || n.type === 'group') {
                const counts = n.type === 'root' ? countsLine() : `${n.children.length} ${n.children.length === 1 ? 'item' : 'itens'} sem épico ou feature`;
                return `<div class="${cls.join(' ')}" data-path="${esc(n.path)}" style="${style}">
                    <div class="bl-node-head"><span class="bl-type">${n.type === 'root' ? 'Visão geral' : 'Atenção'}</span></div>
                    <div class="bl-title">${esc(n.title)}</div>
                    <div class="bl-meta"><span class="bl-sub">${esc(counts)}</span></div>
                    ${toggle}
                </div>`;
            }

            const pct = Math.round(n.fill.ratio * 100);
            const progress = n.progress
                ? `<span class="bl-progress" title="Itens concluídos abaixo deste">✓ ${n.progress.done}/${n.progress.total}</span>`
                : '';
            const warn = n.issues.some(i => i !== 'documentação incompleta')
                ? `<span class="bl-warn" title="${esc(n.issues.join('; '))}">⚠</span>`
                : '';
            return `<div class="${cls.join(' ')}" data-path="${esc(n.path)}" style="${style}" title="${esc(n.path)}">
                <div class="bl-node-head">
                    <span class="bl-type">${TYPES[n.type].label}</span>
                    ${n.id ? `<span class="bl-id">${esc(n.id)}</span>` : ''}
                    ${warn}
                    ${n.status ? `<span class="bl-status">${esc(n.status)}</span>` : ''}
                </div>
                <div class="bl-title">${esc(n.title)}</div>
                <div class="bl-meta">
                    <span class="bl-fill" title="Preenchimento: ${n.fill.done}/${n.fill.total}"><span style="width:${pct}%"></span></span>
                    <span class="bl-sub">${n.fill.done}/${n.fill.total}</span>
                    ${progress}
                </div>
                ${toggle}
            </div>`;
        }

        function countsLine() {
            const c = { epico: 0, feature: 0, item: 0 };
            for (const n of model.nodes.values()) c[n.type]++;
            const plural = (k, one, many) => `${c[k]} ${c[k] === 1 ? one : many}`;
            return `${plural('epico', 'épico', 'épicos')} · ${plural('feature', 'feature', 'features')} · ${plural('item', 'item', 'itens')}`;
        }

        // Nó visível que representa `node` (ele mesmo ou o ancestral recolhido).
        function visibleRep(node) {
            for (const n of ancestry(node).reverse()) {
                if (pos.has(n.path)) return n;
            }
            return null;
        }

        function drawEdges(root, selected) {
            let maxX = 0;
            let maxY = 0;
            for (const p of pos.values()) {
                maxX = Math.max(maxX, p.x + NODE_W);
                maxY = Math.max(maxY, p.y + NODE_H);
            }
            const width = maxX + 240;
            const height = maxY + 80;
            edgesEl.setAttribute('width', width);
            edgesEl.setAttribute('height', height);
            stage.style.width = width + 'px';
            stage.style.height = height + 'px';

            const parts = [`<defs>
                <marker id="bl-arrow-depends" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="rel-depends-head"/></marker>
                <marker id="bl-arrow-blocks" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="rel-blocks-head"/></marker>
            </defs>`];

            // Hierarquia
            for (const p of pos.values()) {
                const n = p.node;
                const parent = n === root ? null : treeParent(n);
                if (!parent || !pos.has(parent.path)) continue;
                const a = pos.get(parent.path);
                const x1 = a.x + NODE_W;
                const y1 = a.y + NODE_H / 2;
                const x2 = p.x;
                const y2 = p.y + NODE_H / 2;
                const mx = (x1 + x2) / 2;
                const active = selected && (selected === n || selected === parent);
                parts.push(`<path class="bl-edge${active ? ' active' : ''}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`);
            }

            // Relações (agregadas no ancestral visível quando recolhidas)
            if (state.showRelations) {
                const seen = new Set();
                const labels = [];
                for (const node of model.nodes.values()) {
                    const from = visibleRep(node);
                    if (!from || !isInside(node, root)) continue;
                    for (const kind of Object.keys(RELATIONS)) {
                        for (const r of node.rel[kind]) {
                            const target = r.path && model.nodes.get(r.path);
                            if (!target || !isInside(target, root)) continue;
                            const to = visibleRep(target);
                            if (!to || to === from) continue;
                            const key = `${kind}|${from.path}|${to.path}`;
                            if (seen.has(key)) continue;
                            seen.add(key);
                            const active = selected && (selected === node || selected === target || selected === from || selected === to);
                            const { d, mid } = relationPath(pos.get(from.path), pos.get(to.path));
                            const marker = kind === 'related' ? '' : ` marker-end="url(#bl-arrow-${kind})"`;
                            parts.push(`<path class="bl-rel rel-${kind}${active ? ' active' : ''}" d="${d}"${marker}/>`);
                            if (active) {
                                labels.push(`<text class="bl-rel-label rel-${kind}" x="${mid.x}" y="${mid.y - 6}" text-anchor="middle">${esc(RELATIONS[kind].label)}</text>`);
                            }
                        }
                    }
                }
                parts.push(...labels);
            }
            edgesEl.innerHTML = parts.join('');
        }

        function relationPath(a, b) {
            const ay = a.y + NODE_H / 2;
            const by = b.y + NODE_H / 2;
            let p0;
            let p1;
            let p2;
            let p3;
            if (b.x > a.x + NODE_W) {
                p0 = [a.x + NODE_W, ay]; p3 = [b.x, by];
                p1 = [p0[0] + 60, ay]; p2 = [p3[0] - 60, by];
            } else if (b.x + NODE_W < a.x) {
                p0 = [a.x, ay]; p3 = [b.x + NODE_W, by];
                p1 = [p0[0] - 60, ay]; p2 = [p3[0] + 60, by];
            } else {
                // Mesma coluna: arco pela direita.
                const bulge = 60 + Math.min(Math.abs(by - ay) / 4, 120);
                p0 = [a.x + NODE_W, ay]; p3 = [b.x + NODE_W, by];
                p1 = [p0[0] + bulge, ay]; p2 = [p3[0] + bulge, by];
            }
            const mid = {
                x: (p0[0] + 3 * p1[0] + 3 * p2[0] + p3[0]) / 8,
                y: (p0[1] + 3 * p1[1] + 3 * p2[1] + p3[1]) / 8
            };
            return { d: `M${p0} C${p1} ${p2} ${p3}`, mid };
        }

        function renderCrumbs(root) {
            const chain = root === model.root ? [model.root] : ancestry(root);
            crumbs.innerHTML = chain.map((n, i) => (
                i === chain.length - 1
                    ? `<span class="bl-crumb current">${esc(n.title)}</span>`
                    : `<button class="bl-crumb" data-focus="${esc(n.path)}">${esc(n.title)}</button><span class="bl-crumb-sep">›</span>`
            )).join('');
        }

        // ── Pan / zoom ─────────────────────────────────

        function applyTransform() {
            const { x, y, k } = state.view;
            stage.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
        }

        function fit() {
            let maxX = 0;
            let maxY = 0;
            for (const p of pos.values()) {
                maxX = Math.max(maxX, p.x + NODE_W);
                maxY = Math.max(maxY, p.y + NODE_H);
            }
            const w = canvas.clientWidth || 800;
            const h = canvas.clientHeight || 600;
            const k = Math.max(0.3, Math.min(1, (w - 80) / (maxX + 120), (h - 80) / maxY));
            state.view.k = k;
            state.view.x = Math.max(40, (w - maxX * k) / 2);
            state.view.y = maxY * k < h - 80 ? (h - maxY * k) / 2 : 40;
            applyTransform();
        }

        function zoomAt(factor, cx, cy) {
            const { x, y, k } = state.view;
            const next = Math.max(0.2, Math.min(2, k * factor));
            state.view.x = cx - (cx - x) * next / k;
            state.view.y = cy - (cy - y) * next / k;
            state.view.k = next;
            applyTransform();
        }

        function centerOn(path) {
            const p = pos.get(path);
            if (!p) return;
            const { k } = state.view;
            state.view.x = canvas.clientWidth / 2 - (p.x + NODE_W / 2) * k;
            state.view.y = canvas.clientHeight / 2 - (p.y + NODE_H / 2) * k;
            applyTransform();
        }

        // Garante que o nó esteja no mapa atual (ajusta foco e abre
        // ancestrais). Devolve true se o layout mudou.
        function reveal(path) {
            const node = nodeByPath(path);
            if (!node) return false;
            let changed = false;
            const focus = nodeByPath(state.focus);
            if (!focus || !isInside(node, focus)) {
                state.focus = ROOT;
                changed = true;
            }
            for (const a of ancestry(node)) {
                if (a !== node && state.collapsed.delete(a.path)) changed = true;
            }
            if (changed) saveState();
            return changed || !pos.has(path);
        }

        function select(path, { center = false } = {}) {
            const changed = reveal(path);
            state.selected = path;
            if (changed) render();
            else refreshHighlight();
            if (center) centerOn(path);
            renderDetail();
        }

        function setFocus(path) {
            state.focus = path;
            state.selected = path;
            state.collapsed.delete(path);
            state.fitPending = true;
            saveState();
            render();
            renderDetail();
        }

        function toggleCollapse(path) {
            if (state.collapsed.has(path)) state.collapsed.delete(path);
            else state.collapsed.add(path);
            saveState();
            render();
        }

        // ── Painel de detalhes ─────────────────────────

        function chip(path, raw) {
            const node = path && model.nodes.get(path);
            if (node) {
                return `<button class="bl-chip type-${node.type}" data-select="${esc(path)}" title="${esc(path)}">
                    <span class="bl-dot"></span><span class="bl-chip-title">${esc(node.id ? `${node.id} · ${node.title}` : node.title)}</span>
                    ${node.status ? `<span class="bl-chip-status status-${node.statusKey}">${esc(node.status)}</span>` : ''}
                </button>`;
            }
            if (path) {
                return `<button class="bl-chip note" data-open="${esc(path)}" title="Nota fora do backlog">📄 ${esc(api.noteTitle(path))}</button>`;
            }
            return `<span class="bl-chip missing" title="Nenhuma nota com esse nome">⚠ ${esc(raw)} — não encontrada</span>`;
        }

        function relationGroup(label, entries, hint) {
            if (!entries.length) return '';
            return `<div class="bl-rel-group">
                <div class="bl-rel-label-row">${esc(label)} <span class="bl-count">${entries.length}</span>${hint ? `<span class="bl-hint">${esc(hint)}</span>` : ''}</div>
                <div class="bl-chips">${entries.join('')}</div>
            </div>`;
        }

        async function renderDetail() {
            const gen = ++detailGen;
            const node = nodeByPath(state.selected);
            if (!node || node.type === 'root' || node.type === 'group') {
                detail.innerHTML = overviewHtml(node && node.type === 'group' ? node : null);
                return;
            }

            const def = TYPES[node.type];
            const chain = ancestry(node).filter(n => n.type !== 'root');
            const childType = def.child ? TYPES[def.child].label : null;
            const statusOptions = Object.entries(STATUS).map(([key, s]) =>
                `<option value="${key}"${node.statusKey === key ? ' selected' : ''}>${s.label}</option>`).join('');
            const unknownStatus = node.status && node.statusKey === 'outro'
                ? `<option value="" selected>${esc(node.status)}</option>` : '';
            const noStatus = !node.status ? '<option value="" selected>—</option>' : '';

            const pct = Math.round(node.fill.ratio * 100);
            const checks = node.fill.checks.map(c => `<li class="bl-check ${c.state}">
                <span class="bl-check-mark">${c.ok ? '✓' : '○'}</span>${esc(c.label)}
                ${c.state === 'vazia' ? '<span class="bl-hint">seção vazia</span>' : ''}
                ${c.state === 'ausente' ? '<span class="bl-hint">falta</span>' : ''}
            </li>`).join('');

            const rel = (list) => list.map(r => chip(r.path, r.raw));
            const inv = (list) => list.map(p => chip(p));
            const related = [...rel(node.rel.related), ...inv(node.inverse.related.filter(p => !node.rel.related.some(r => r.path === p)))];
            const parentEntries = node.parent ? [chip(node.parent.path)] : (node.parentRaw ? [chip(null, node.parentRaw)] : []);
            const relationsHtml = [
                relationGroup('Pai', parentEntries),
                relationGroup(childType ? `Filhos (${childType})` : 'Filhos', node.children.map(c => chip(c.path))),
                relationGroup('Depende de', rel(node.rel.depends), 'precisa estar pronto antes'),
                relationGroup('É requisito para', inv(node.inverse.dependents)),
                relationGroup('Bloqueia', rel(node.rel.blocks)),
                relationGroup('Bloqueado por', inv(node.inverse.blockedBy)),
                relationGroup('Relacionados', related)
            ].join('') || '<p class="bl-muted">Sem relações. Use os campos <code>pai</code>, <code>depende</code>, <code>bloqueia</code> e <code>relacionado</code> no frontmatter.</p>';

            const progress = node.progress
                ? `<section class="bl-section"><h4>Progresso</h4>
                    <div class="bl-bar"><span style="width:${Math.round(node.progress.done / node.progress.total * 100)}%"></span></div>
                    <p class="bl-muted">${node.progress.done} de ${node.progress.total} itens concluídos abaixo ${def.thisLabel}.</p>
                  </section>`
                : '';
            const issues = node.issues.filter(i => i !== 'documentação incompleta');

            detail.innerHTML = `
                <div class="bl-d-crumbs">${chain.map(n => n === node
                    ? `<span>${esc(n.title)}</span>`
                    : `<button data-select="${esc(n.path)}">${esc(n.title)}</button><span class="bl-crumb-sep">›</span>`).join('')}</div>
                <div class="bl-d-head type-${node.type}">
                    <span class="bl-type">${def.label}</span>
                    ${node.id ? `<span class="bl-id">${esc(node.id)}</span>` : ''}
                </div>
                <h2 class="bl-d-title">${esc(node.title)}</h2>
                <div class="bl-d-fields">
                    <label>Status <select class="bl-status-select">${noStatus}${unknownStatus}${statusOptions}</select></label>
                    ${node.owner ? `<span>Responsável: <b>${esc(node.owner)}</b></span>` : ''}
                    ${node.estimate ? `<span>Estimativa: <b>${esc(node.estimate)}</b></span>` : ''}
                </div>
                <div class="bl-d-actions">
                    <button class="tool-btn-text" data-action="open">Abrir no editor</button>
                    ${node.children.length ? '<button class="tool-btn-text" data-action="focus">Abrir como mapa</button>' : ''}
                    ${childType ? `<button class="tool-btn-text" data-action="child">+ ${childType}</button>` : ''}
                </div>
                ${issues.length ? `<div class="bl-issues">⚠ ${issues.map(esc).join(' · ')}</div>` : ''}
                <section class="bl-section">
                    <h4>Preenchimento <span class="bl-count">${node.fill.done}/${node.fill.total}</span></h4>
                    <div class="bl-bar"><span style="width:${pct}%"></span></div>
                    <ul class="bl-checks">${checks}</ul>
                </section>
                <section class="bl-section"><h4>Relações</h4>${relationsHtml}</section>
                ${progress}
                <section class="bl-section">
                    <h4>Documento</h4>
                    <div class="bl-doc markdown-body"><p class="bl-muted">Carregando…</p></div>
                </section>`;

            const docEl = detail.querySelector('.bl-doc');
            const tmp = document.createElement('div');
            await api.renderInto(tmp, api.getText(node.path) || '', {
                interactive: false,
                dark: true,
                idPrefix: 'bl-',
                basePath: node.path,
                isStale: () => gen !== detailGen
            });
            if (gen !== detailGen) return;
            docEl.replaceChildren(...tmp.childNodes);
        }

        function overviewHtml(group) {
            const nodes = [...model.nodes.values()];
            if (!nodes.length) {
                return `<h2 class="bl-d-title">Backlog</h2>
                    <p class="bl-muted">Nenhum épico, feature ou item nesta pasta ainda.</p>
                    ${guideHtml()}`;
            }
            const byType = (t) => nodes.filter(n => n.type === t);
            const avg = (list) => list.length ? Math.round(list.reduce((s, n) => s + n.fill.ratio, 0) / list.length * 100) : 0;
            const statusCounts = {};
            for (const n of byType('item')) statusCounts[n.statusKey || 'semstatus'] = (statusCounts[n.statusKey || 'semstatus'] || 0) + 1;
            const items = byType('item').length || 1;
            const bar = Object.entries(statusCounts).map(([k, v]) =>
                `<span class="status-${k}" style="width:${v / items * 100}%" title="${esc((STATUS[k] && STATUS[k].label) || (k === 'semstatus' ? 'Sem status' : 'Outro'))}: ${v}"></span>`).join('');
            const legend = Object.entries(statusCounts).map(([k, v]) =>
                `<span class="bl-legend-item"><span class="bl-dot status-${k}"></span>${esc((STATUS[k] && STATUS[k].label) || (k === 'semstatus' ? 'Sem status' : 'Outro'))} ${v}</span>`).join('');

            const scope = group ? group.children : nodes;
            const attention = scope
                .filter(n => n.issues.length)
                .sort((a, b) => a.fill.ratio - b.fill.ratio)
                .slice(0, 20)
                .map(n => `<li>${chip(n.path)}<span class="bl-hint">${esc(n.issues.join(' · '))}</span></li>`)
                .join('');

            return `
                <h2 class="bl-d-title">${group ? 'Itens sem pai' : 'Visão geral'}</h2>
                ${group ? '<p class="bl-muted">Features e itens sem épico ou feature acima. Defina o campo <code>pai</code> para encaixá-los.</p>' : ''}
                <div class="bl-stats">
                    <div class="bl-stat type-epico"><b>${byType('epico').length}</b><span>épicos</span><small>${avg(byType('epico'))}% preenchidos</small></div>
                    <div class="bl-stat type-feature"><b>${byType('feature').length}</b><span>features</span><small>${avg(byType('feature'))}% preenchidas</small></div>
                    <div class="bl-stat type-item"><b>${byType('item').length}</b><span>itens</span><small>${avg(byType('item'))}% preenchidos</small></div>
                </div>
                ${byType('item').length ? `<section class="bl-section"><h4>Status dos itens</h4><div class="bl-stack">${bar}</div><div class="bl-legend-row">${legend}</div></section>` : ''}
                <section class="bl-section"><h4>Precisa de atenção <span class="bl-count">${scope.filter(n => n.issues.length).length}</span></h4>
                    ${attention ? `<ul class="bl-attention">${attention}</ul>` : '<p class="bl-muted">Nada pendente.</p>'}
                </section>
                <details class="bl-guide-wrap"><summary>Como estruturar as notas</summary>${guideHtml()}</details>`;
        }

        function guideHtml() {
            return `<div class="bl-guide">
                <p>Cada épico, feature ou item é uma nota com frontmatter:</p>
<pre>---
tipo: feature
id: FT-01
pai: "[[Nome do épico]]"
status: em andamento
depende: ["[[Outra feature]]"]
bloqueia: ["[[Item X]]"]
relacionado: ["[[Nota Y]]"]
---</pre>
                <p><b>tipo</b>: epico, feature ou item. <b>pai</b> monta a hierarquia. <b>depende</b>, <b>bloqueia</b> e <b>relacionado</b> viram setas no mapa.</p>
                <p>O preenchimento compara as seções <code>##</code> da nota com o modelo do tipo. Use <b>+ Épico</b> ou <b>+ Feature</b>/<b>+ Item</b> para criar notas já com o modelo.</p>
                <button class="btn-primary bl-first-epic" data-action="new-epic">+ Criar épico</button>
            </div>`;
        }

        // ── Criação e edição ───────────────────────────

        function nextId(type) {
            const prefix = TYPES[type].prefix;
            let max = 0;
            for (const n of model.nodes.values()) {
                const m = n.id.match(new RegExp('^' + prefix + '-(\\d+)$', 'i'));
                if (m) max = Math.max(max, parseInt(m[1], 10));
            }
            return `${prefix}-${String(max + 1).padStart(2, '0')}`;
        }

        // Texto do link para `path`: o título, ou o caminho se o título se repete.
        function linkText(path) {
            const title = api.noteTitle(path);
            const dupes = api.listNotes().filter(p => api.noteTitle(p).toLowerCase() === title.toLowerCase());
            return dupes.length > 1 ? path.replace(/\.md$/i, '') : title;
        }

        function template(type, name, id, parentPath) {
            const def = TYPES[type];
            const lines = ['---', `tipo: ${type}`, `id: ${id}`];
            if (parentPath) lines.push(`pai: "[[${linkText(parentPath)}]]"`);
            lines.push('status: rascunho');
            if (type === 'item') lines.push('estimativa: ');
            if (type !== 'epico') lines.push('depende: ');
            lines.push('---', '', `# ${name}`, '');
            def.sections.forEach((aliases, i) => {
                lines.push(`## ${aliases[0]}`, '', `<!-- ${def.hints[i]} -->`, '');
                if (aliases[0].startsWith('Critérios')) lines.push('- [ ] ', '');
            });
            return lines.join('\n');
        }

        async function createItem(type, parentPath) {
            const def = TYPES[type];
            const parent = parentPath ? model.nodes.get(parentPath) : null;
            const folder = parent ? api.dirOf(parent.path) : api.selectedFolder();
            const where = `Em: ${folder || '(raiz)'}${parent ? ` · filho de ${parent.title}` : ''}`;
            const name = await api.promptName(def.newLabel, where, 'Nome da nota');
            if (!name) return;
            const clean = name.replace(/\.md$/i, '');
            const path = await api.createFile(clean, folder, template(type, clean, nextId(type), parentPath), false);
            if (!path) return;
            // refreshFileList já reconstruiu o modelo via onIndexChanged.
            if (parent) state.collapsed.delete(parent.path);
            select(path, { center: true });
        }

        async function changeStatus(path, key) {
            const text = api.getText(path);
            if (text == null || !STATUS_WRITE[key]) return;
            const value = STATUS_WRITE[key];
            const m = text.match(FRONTMATTER_RE);
            let next;
            if (!m) {
                next = `---\nstatus: ${value}\n---\n` + text;
            } else {
                const block = m[1];
                const nl = text.includes('\r\n') ? '\r\n' : '\n';
                const lineRe = /^(status|estado)[ \t]*:.*$/im;
                const newBlock = lineRe.test(block) ? block.replace(lineRe, (_, key2) => `${key2}: ${value}`) : `${block}${nl}status: ${value}`;
                next = text.slice(0, m.index) + m[0].replace(block, () => newBlock) + text.slice(m.index + m[0].length);
            }
            try {
                await api.writeNote(path, next);
            } catch (err) {
                console.error('Erro ao mudar status:', err);
                alert('Não foi possível gravar o status.');
            }
        }

        // ── Eventos ────────────────────────────────────

        nodesEl.addEventListener('click', (e) => {
            const toggle = e.target.closest('[data-toggle]');
            if (toggle) {
                e.stopPropagation();
                toggleCollapse(toggle.dataset.toggle);
                return;
            }
            const el = e.target.closest('.bl-node');
            if (el) select(el.dataset.path);
        });

        // Duplo clique: nó com filhos abre como mapa; folha abre no editor.
        nodesEl.addEventListener('dblclick', (e) => {
            if (e.target.closest('[data-toggle]')) return;
            const el = e.target.closest('.bl-node');
            if (!el) return;
            const node = nodeByPath(el.dataset.path);
            if (!node) return;
            if (node.children.length) setFocus(node.path);
            else if (node.fill) api.openNote(node.path);
        });

        crumbs.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-focus]');
            if (btn) setFocus(btn.dataset.focus);
        });

        detail.addEventListener('click', (e) => {
            const target = e.target.closest('[data-select], [data-open], [data-action], [data-wikilink], a[href]');
            if (!target) return;
            if (target.dataset.select) {
                select(target.dataset.select, { center: true });
            } else if (target.dataset.open) {
                api.openNote(target.dataset.open);
            } else if (target.dataset.action) {
                const node = nodeByPath(state.selected);
                const action = target.dataset.action;
                if (action === 'open' && node) api.openNote(node.path);
                else if (action === 'focus' && node) setFocus(node.path);
                else if (action === 'child' && node) createItem(TYPES[node.type].child, node.path);
                else if (action === 'new-epic') createItem('epico', null);
            } else if (target.dataset.wikilink) {
                e.preventDefault();
                const { note } = api.parseLinkTarget(target.dataset.wikilink);
                const path = api.resolveNotePath(note);
                if (path && model.nodes.has(path)) select(path, { center: true });
                else if (path) api.openNote(path);
            } else {
                e.preventDefault();
                const href = target.getAttribute('href');
                if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener');
            }
        });

        detail.addEventListener('change', (e) => {
            if (!e.target.classList.contains('bl-status-select')) return;
            changeStatus(state.selected, e.target.value);
        });

        empty.addEventListener('click', (e) => {
            if (e.target.closest('[data-action="new-epic"]')) createItem('epico', null);
        });

        $('#bl-new-epic').addEventListener('click', () => createItem('epico', null));
        $('#bl-fit').addEventListener('click', fit);
        $('#bl-expand').addEventListener('click', () => {
            state.collapsed.clear();
            saveState();
            render();
            fit();
        });
        $('#bl-collapse').addEventListener('click', () => {
            const focus = nodeByPath(state.focus);
            const walk = (n) => {
                if (n.children.length && n !== focus) state.collapsed.add(n.path);
                n.children.forEach(walk);
            };
            walk(focus || model.root);
            saveState();
            render();
            fit();
        });
        relToggle.addEventListener('change', () => {
            state.showRelations = relToggle.checked;
            saveState();
            render();
        });
        search.addEventListener('input', () => {
            state.query = search.value.trim();
            render();
        });
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const first = order.find(n => n.fill && matchesQuery(n));
                if (first) select(first.path, { center: true });
            } else if (e.key === 'Escape') {
                search.value = '';
                state.query = '';
                render();
                canvas.focus();
            }
        });
        view.querySelectorAll('[data-zoom]').forEach(btn => {
            btn.addEventListener('click', () => {
                zoomAt(btn.dataset.zoom === 'in' ? 1.2 : 1 / 1.2, canvas.clientWidth / 2, canvas.clientHeight / 2);
            });
        });

        // Arrastar o fundo move o mapa; roda do mouse rola; Ctrl+roda (ou
        // pinça no trackpad) dá zoom.
        let drag = null;
        canvas.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('.bl-node, button, input, .bl-legend')) return;
            drag = { x: e.clientX, y: e.clientY, vx: state.view.x, vy: state.view.y };
            canvas.setPointerCapture(e.pointerId);
            canvas.classList.add('dragging');
        });
        canvas.addEventListener('pointermove', (e) => {
            if (!drag) return;
            state.view.x = drag.vx + e.clientX - drag.x;
            state.view.y = drag.vy + e.clientY - drag.y;
            applyTransform();
        });
        const endDrag = () => {
            drag = null;
            canvas.classList.remove('dragging');
        };
        canvas.addEventListener('pointerup', endDrag);
        canvas.addEventListener('pointercancel', endDrag);
        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                const r = canvas.getBoundingClientRect();
                zoomAt(Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
            } else {
                state.view.x -= e.deltaX;
                state.view.y -= e.deltaY;
                applyTransform();
            }
        }, { passive: false });

        // Teclado: setas navegam pela árvore, Espaço abre/recolhe, Enter abre
        // no editor.
        canvas.addEventListener('keydown', (e) => {
            const node = nodeByPath(state.selected);
            if (!node) return;
            const visibleKids = node.children.filter(c => pos.has(c.path));
            const parent = treeParent(node);
            const siblings = parent ? parent.children.filter(c => pos.has(c.path)) : [];
            const i = siblings.indexOf(node);
            let next = null;
            if (e.key === 'ArrowRight') {
                if (node.children.length && state.collapsed.has(node.path)) {
                    toggleCollapse(node.path);
                    e.preventDefault();
                    return;
                }
                next = visibleKids[0];
            } else if (e.key === 'ArrowLeft') {
                next = parent && pos.has(parent.path) ? parent : null;
            } else if (e.key === 'ArrowDown') {
                next = siblings[i + 1];
            } else if (e.key === 'ArrowUp') {
                next = siblings[i - 1];
            } else if (e.key === ' ') {
                if (node.children.length) toggleCollapse(node.path);
                e.preventDefault();
                return;
            } else if (e.key === 'Enter') {
                if (node.fill) api.openNote(node.path);
                e.preventDefault();
                return;
            } else if (e.key === '/') {
                search.focus();
                e.preventDefault();
                return;
            } else {
                return;
            }
            e.preventDefault();
            if (next) {
                select(next.path);
                keepVisible(next.path);
            }
        });

        function keepVisible(path) {
            const p = pos.get(path);
            if (!p) return;
            const { x, y, k } = state.view;
            const left = x + p.x * k;
            const top = y + p.y * k;
            const margin = 40;
            if (left < margin || top < margin || left + NODE_W * k > canvas.clientWidth - margin || top + NODE_H * k > canvas.clientHeight - margin) {
                centerOn(path);
            }
        }

        btnMap.addEventListener('click', toggle);

        // ── Ciclo de vida ──────────────────────────────

        function isVisible() {
            return !view.classList.contains('hidden');
        }

        function rebuild() {
            if (state.dir !== api.dirName()) loadState();
            model = buildModel();
            if (!nodeByPath(state.selected)) state.selected = state.focus;
        }

        async function show() {
            if (!api.hasFolder()) {
                await api.openDirectory();
                if (!api.hasFolder()) return;
            }
            api.hideEditorArea();
            view.classList.remove('hidden');
            main.classList.add('map-mode');
            btnMap.classList.add('active');
            // Sempre reconstrói: a nota aberta pode ter edições ainda não salvas.
            rebuild();
            // Aberto a partir de uma nota do backlog: seleciona essa nota.
            const current = api.currentFile();
            if (current && model.nodes.has(current)) {
                reveal(current);
                state.selected = current;
                render();
                centerOn(current);
            } else {
                render();
            }
            renderDetail();
            canvas.focus({ preventScroll: true });
        }

        function hide() {
            if (!isVisible()) return;
            view.classList.add('hidden');
            main.classList.remove('map-mode');
            btnMap.classList.remove('active');
            api.showEditorArea();
        }

        function toggle() {
            if (isVisible()) hide();
            else show();
        }

        function onIndexChanged() {
            if (!isVisible()) return;
            rebuild();
            render();
            renderDetail();
        }

        function onFileOpened() {
            hide();
        }

        new ResizeObserver(() => { if (isVisible() && state.fitPending) fit(); }).observe(canvas);

        return { show, hide, toggle, isVisible, onIndexChanged, onFileOpened };
    }

    window.MDBacklog = { create };
})();
