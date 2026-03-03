/* ===== MD EDITOR — APP.JS ===== */

(() => {
    'use strict';

    // ── State ──────────────────────────────────────────
    let dirHandle = null;
    let currentFileHandle = null;
    let currentFileName = '';
    let isDirty = false;
    let autoSaveTimer = null;
    const AUTOSAVE_DELAY = 2000;

    // ── Wikilink / Backlink State ──────────────────────
    let fileHandleMap = {};        // { "path/note.md": FileSystemFileHandle }
    let backlinkIndex = {};        // { "Note Title": ["path/a.md", "path/b.md"] }
    let allFileTitles = new Set(); // all note titles (filename without .md)

    // ── DOM Elements ───────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const welcomeScreen = $('#welcome-screen');
    const splitPane = $('#split-pane');
    const editor = $('#editor');
    const preview = $('#preview');
    const fileList = $('#file-list');
    const fileName = $('#file-name');
    const saveStatus = $('#save-status');
    const statusDot = saveStatus.querySelector('.status-dot');
    const statusText = saveStatus.querySelector('.status-text');

    // Buttons
    const btnOpenFolder = $('#btn-open-folder');
    const btnWelcomeOpen = $('#btn-welcome-open');
    const btnNewFile = $('#btn-new-file');

    // Modals
    const modalOverlay = $('#modal-overlay');
    const newFileInput = $('#new-file-input');
    const modalCancel = $('#modal-cancel');
    const modalCreate = $('#modal-create');
    const deleteOverlay = $('#delete-modal-overlay');
    const deleteText = $('#delete-confirm-text');
    const deleteCancel = $('#delete-cancel');
    const deleteConfirm = $('#delete-confirm');

    // Buttons — Export / Preview
    const btnExportHtml = $('#btn-export-html');
    const btnPreviewHtml = $('#btn-preview-html');

    // ── Mermaid Setup ──────────────────────────────────
    if (typeof mermaid !== 'undefined') {
        mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            themeVariables: {
                darkMode: true,
                background: '#161b22',
                primaryColor: '#1f6feb',
                primaryTextColor: '#e6edf3',
                lineColor: '#58a6ff',
                secondaryColor: '#21262d',
                tertiaryColor: '#30363d'
            }
        });
    }

    let mermaidIdCounter = 0;

    // ── Marked Setup ───────────────────────────────────
    marked.use({
        breaks: true,
        gfm: true,
        renderer: {
            code(text, lang) {
                const code = text || '';
                const language = (lang || '').split(/\s/)[0];
                if (language === 'mermaid') {
                    const id = `mermaid-${mermaidIdCounter++}`;
                    return `<div class="mermaid-block" data-mermaid-id="${id}">${code}</div>`;
                }
                if (language && hljs.getLanguage(language)) {
                    const highlighted = hljs.highlight(code, { language }).value;
                    return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
                }
                const highlighted = hljs.highlightAuto(code).value;
                return `<pre><code class="hljs">${highlighted}</code></pre>`;
            }
        }
    });

    // ── Wikilink Helpers ───────────────────────────────

    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function extractWikilinks(content) {
        const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        const links = new Set();
        let m;
        while ((m = re.exec(content)) !== null) {
            links.add(m[1].trim());
        }
        return links;
    }

    // ── Wikilink Marked Extension ─────────────────────
    marked.use({
        extensions: [{
            name: 'wikilink',
            level: 'inline',
            start(src) { return src.indexOf('[['); },
            tokenizer(src) {
                const match = src.match(/^\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/);
                if (match) {
                    return {
                        type: 'wikilink',
                        raw: match[0],
                        target: match[1].trim(),
                        display: match[2] ? match[2].trim() : match[1].trim()
                    };
                }
            },
            renderer(token) {
                const exists = allFileTitles.has(token.target);
                const cls = exists ? 'wikilink' : 'wikilink wikilink-missing';
                const label = escapeHtml(token.display);
                const target = escapeHtml(token.target);
                return `<a class="${cls}" data-wikilink="${target}" href="#">${label}</a>`;
            }
        }]
    });

    // ── File System Access API ─────────────────────────

    async function openDirectory() {
        try {
            dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            await refreshFileList();
            showEditor();
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Erro ao abrir pasta:', err);
                alert('Não foi possível abrir a pasta. Verifique se o navegador é compatível (Chrome/Edge).');
            }
        }
    }

    async function refreshFileList() {
        if (!dirHandle) return;
        const tree = await scanDirectory(dirHandle, '');
        renderFileTree(tree);
        await buildBacklinkIndex(tree);
        updateBacklinksPanel();
    }

    async function scanDirectory(handle, path) {
        const entries = { folders: [], files: [] };

        for await (const [name, entryHandle] of handle) {
            if (entryHandle.kind === 'directory') {
                const subPath = path ? `${path}/${name}` : name;
                const children = await scanDirectory(entryHandle, subPath);
                entries.folders.push({
                    name: name,
                    path: subPath,
                    handle: entryHandle,
                    children: children
                });
            } else if (entryHandle.kind === 'file' && name.endsWith('.md')) {
                entries.files.push({
                    name: name,
                    path: path ? `${path}/${name}` : name,
                    handle: entryHandle
                });
            }
        }

        entries.folders.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
        entries.files.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));

        return entries;
    }

    function countFiles(tree) {
        let count = tree.files.length;
        for (const folder of tree.folders) {
            count += countFiles(folder.children);
        }
        return count;
    }

    function renderFileTree(tree) {
        fileList.innerHTML = '';

        if (countFiles(tree) === 0) {
            fileList.innerHTML = '<li class="empty-state">Nenhum arquivo .md encontrado</li>';
            return;
        }

        renderTreeLevel(tree, fileList, 0);
    }

    function renderTreeLevel(tree, container, depth) {
        // Renderizar pastas primeiro
        tree.folders.forEach(folder => {
            if (countFiles(folder.children) === 0) return;

            const folderLi = document.createElement('li');
            folderLi.classList.add('folder-item');
            folderLi.style.paddingLeft = `${16 + depth * 16}px`;

            const childContainer = document.createElement('ul');
            childContainer.classList.add('folder-children', 'expanded');

            folderLi.innerHTML = `
                <span class="folder-toggle expanded">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M3 2l4 3-4 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </span>
                <span class="file-icon">📁</span>
                <span class="folder-label">${folder.name}</span>
            `;

            folderLi.addEventListener('click', (e) => {
                if (e.target.closest('.file-item')) return;
                const toggle = folderLi.querySelector('.folder-toggle');
                const isExpanded = childContainer.classList.contains('expanded');
                if (isExpanded) {
                    childContainer.classList.remove('expanded');
                    toggle.classList.remove('expanded');
                } else {
                    childContainer.classList.add('expanded');
                    toggle.classList.add('expanded');
                }
            });

            container.appendChild(folderLi);
            renderTreeLevel(folder.children, childContainer, depth + 1);
            container.appendChild(childContainer);
        });

        // Renderizar arquivos
        tree.files.forEach(fileEntry => {
            const li = document.createElement('li');
            li.classList.add('file-item');
            li.style.paddingLeft = `${16 + depth * 16}px`;
            if (fileEntry.path === currentFileName) li.classList.add('active');

            li.innerHTML = `
                <span class="file-icon">📄</span>
                <span class="file-label" title="${fileEntry.path}">${fileEntry.name}</span>
                <button class="file-delete" title="Deletar" data-path="${fileEntry.path}">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                    </svg>
                </button>
            `;

            li.addEventListener('click', (e) => {
                if (e.target.closest('.file-delete') || li.classList.contains('renaming')) return;
                openFileByPath(fileEntry.path, fileEntry.handle);
            });

            li.querySelector('.file-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                promptDeleteFile(fileEntry.path);
            });

            li.querySelector('.file-label').addEventListener('dblclick', (e) => {
                e.stopPropagation();
                startInlineRename(li, fileEntry);
            });

            container.appendChild(li);
        });
    }

    async function openFileByPath(path, handle) {
        try {
            if (isDirty && currentFileHandle) {
                await saveCurrentFile();
            }

            const file = await handle.getFile();
            const content = await file.text();

            currentFileHandle = handle;
            currentFileName = path;
            isDirty = false;

            editor.value = content;
            updatePreview();
            updateFileName();
            setStatus('saved');
            highlightActiveFile();
            updateBacklinksPanel();
            const bp = $('#backlinks-panel');
            if (bp) bp.classList.remove('hidden');
        } catch (err) {
            console.error('Erro ao abrir arquivo:', err);
        }
    }

    async function openFile(name) {
        try {
            const handle = await dirHandle.getFileHandle(name);
            await openFileByPath(name, handle);
        } catch (err) {
            console.error('Erro ao abrir arquivo:', err);
        }
    }

    async function saveCurrentFile() {
        if (!currentFileHandle) return;
        try {
            setStatus('saving');
            const writable = await currentFileHandle.createWritable();
            await writable.write(editor.value);
            await writable.close();
            isDirty = false;
            setStatus('saved');
            updateBacklinkIndexForCurrentFile();
            updateBacklinksPanel();
        } catch (err) {
            console.error('Erro ao salvar:', err);
            setStatus('unsaved');
            // If permission was revoked, try to re-request
            if (err.name === 'NotAllowedError') {
                try {
                    const permission = await currentFileHandle.requestPermission({ mode: 'readwrite' });
                    if (permission === 'granted') {
                        await saveCurrentFile();
                    }
                } catch (_) { /* user denied */ }
            }
        }
    }

    async function createFile(name) {
        if (!dirHandle) return;
        if (!name.endsWith('.md')) name += '.md';
        try {
            const handle = await dirHandle.getFileHandle(name, { create: true });
            const writable = await handle.createWritable();
            await writable.write('');
            await writable.close();
            await refreshFileList();
            await openFile(name);
        } catch (err) {
            console.error('Erro ao criar arquivo:', err);
            alert('Não foi possível criar o arquivo.');
        }
    }

    let pendingDeleteName = '';

    function promptDeleteFile(name) {
        pendingDeleteName = name;
        deleteText.textContent = `Tem certeza que deseja deletar "${name}"?`;
        deleteOverlay.classList.remove('hidden');
    }

    async function deleteFile(path) {
        if (!dirHandle) return;
        try {
            const parts = path.split('/');
            const fileName = parts.pop();
            let parentHandle = dirHandle;

            for (const part of parts) {
                parentHandle = await parentHandle.getDirectoryHandle(part);
            }

            await parentHandle.removeEntry(fileName);

            // Clean up index structures
            const deletedTitle = fileName.replace(/\.md$/i, '');
            delete fileHandleMap[path];
            allFileTitles.delete(deletedTitle);
            for (const key of Object.keys(backlinkIndex)) {
                backlinkIndex[key] = backlinkIndex[key].filter(p => p !== path);
                if (backlinkIndex[key].length === 0) delete backlinkIndex[key];
            }
            delete backlinkIndex[deletedTitle];

            if (path === currentFileName) {
                currentFileHandle = null;
                currentFileName = '';
                editor.value = '';
                updatePreview();
                updateFileName();
                setStatus('saved');
                const bp = $('#backlinks-panel');
                if (bp) bp.classList.add('hidden');
            }
            await refreshFileList();
        } catch (err) {
            console.error('Erro ao deletar:', err);
            alert('Não foi possível deletar o arquivo.');
        }
    }

    // ── Backlink Index ─────────────────────────────────

    async function buildBacklinkIndex(tree) {
        fileHandleMap = {};
        backlinkIndex = {};
        allFileTitles = new Set();

        // Pass 1: collect all titles and handles
        function collectTitlesAndHandles(subtree) {
            for (const f of subtree.files) {
                fileHandleMap[f.path] = f.handle;
                allFileTitles.add(f.name.replace(/\.md$/i, ''));
            }
            for (const folder of subtree.folders) {
                collectTitlesAndHandles(folder.children);
            }
        }
        collectTitlesAndHandles(tree);

        // Pass 2: read content and build backlink index
        async function indexContent(subtree) {
            for (const f of subtree.files) {
                try {
                    const file = await f.handle.getFile();
                    const content = await file.text();
                    for (const targetTitle of extractWikilinks(content)) {
                        if (!backlinkIndex[targetTitle]) backlinkIndex[targetTitle] = [];
                        backlinkIndex[targetTitle].push(f.path);
                    }
                } catch (_) { /* skip unreadable */ }
            }
            for (const folder of subtree.folders) {
                await indexContent(folder.children);
            }
        }
        await indexContent(tree);
    }

    function updateBacklinkIndexForCurrentFile() {
        if (!currentFileName) return;
        // Remove current file from all backlink lists
        for (const key of Object.keys(backlinkIndex)) {
            backlinkIndex[key] = backlinkIndex[key].filter(p => p !== currentFileName);
            if (backlinkIndex[key].length === 0) delete backlinkIndex[key];
        }
        // Re-add based on current editor content
        for (const targetTitle of extractWikilinks(editor.value)) {
            if (!backlinkIndex[targetTitle]) backlinkIndex[targetTitle] = [];
            backlinkIndex[targetTitle].push(currentFileName);
        }
    }

    function updateBacklinksPanel() {
        const panel = $('#backlinks-panel');
        if (!panel) return;
        if (!currentFileName) return;

        const title = currentFileName.split('/').pop().replace(/\.md$/i, '');
        const linkedPaths = backlinkIndex[title] || [];
        const linkedList = $('#backlinks-linked-list');
        const countEl = $('#backlinks-linked-count');

        if (countEl) countEl.textContent = linkedPaths.length;
        if (!linkedList) return;
        linkedList.innerHTML = '';

        if (linkedPaths.length === 0) {
            const li = document.createElement('li');
            li.className = 'backlink-empty';
            li.textContent = 'Nenhuma nota aponta para cá';
            linkedList.appendChild(li);
        } else {
            linkedPaths.forEach(path => {
                const li = document.createElement('li');
                li.className = 'backlink-item';
                const name = path.split('/').pop().replace(/\.md$/i, '');
                li.innerHTML = `<span class="backlink-icon">📄</span><span class="backlink-name">${escapeHtml(name)}</span>`;
                li.title = path;
                li.addEventListener('click', () => {
                    const handle = fileHandleMap[path];
                    if (handle) openFileByPath(path, handle);
                });
                linkedList.appendChild(li);
            });
        }
    }

    // ── Rename File ────────────────────────────────────

    function startInlineRename(li, fileEntry) {
        if (li.classList.contains('renaming')) return;
        li.classList.add('renaming');
        const labelSpan = li.querySelector('.file-label');
        const oldDisplayName = fileEntry.name.replace(/\.md$/i, '');

        const input = document.createElement('input');
        input.type = 'text';
        input.value = oldDisplayName;
        input.className = 'rename-input';
        labelSpan.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = async () => {
            if (committed) return;
            committed = true;
            const newName = input.value.trim();
            li.classList.remove('renaming');
            if (newName && newName !== oldDisplayName) {
                await renameFile(fileEntry, newName + '.md');
            } else {
                await refreshFileList();
            }
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') {
                committed = true;
                li.classList.remove('renaming');
                refreshFileList();
            }
        });
    }

    async function renameFile(fileEntry, newName) {
        if (!dirHandle) return;
        const parts = fileEntry.path.split('/');
        const oldFileName = parts.pop();
        let parentHandle = dirHandle;

        for (const part of parts) {
            parentHandle = await parentHandle.getDirectoryHandle(part);
        }

        try {
            const oldFile = await fileEntry.handle.getFile();
            const content = await oldFile.text();

            const newHandle = await parentHandle.getFileHandle(newName, { create: true });
            const writable = await newHandle.createWritable();
            await writable.write(content);
            await writable.close();

            await parentHandle.removeEntry(oldFileName);

            const oldTitle = oldFileName.replace(/\.md$/i, '');
            const newTitle = newName.replace(/\.md$/i, '');
            await updateWikilinkReferences(oldTitle, newTitle);

            const newPath = parts.length > 0 ? parts.join('/') + '/' + newName : newName;
            if (fileEntry.path === currentFileName) {
                currentFileName = newPath;
                currentFileHandle = newHandle;
                updateFileName();
            }

            await refreshFileList();
        } catch (err) {
            console.error('Erro ao renomear:', err);
            alert('Não foi possível renomear o arquivo.');
            await refreshFileList();
        }
    }

    async function updateWikilinkReferences(oldTitle, newTitle) {
        const re = new RegExp(
            '\\[\\[' + escapeRegex(oldTitle) + '(\\|[^\\]]*)?\\]\\]',
            'gi'
        );

        for (const [path, handle] of Object.entries(fileHandleMap)) {
            try {
                const file = await handle.getFile();
                const content = await file.text();
                if (!re.test(content)) continue;
                re.lastIndex = 0;
                const updated = content.replace(re, (match, alias) => {
                    return alias ? `[[${newTitle}${alias}]]` : `[[${newTitle}]]`;
                });
                const writable = await handle.createWritable();
                await writable.write(updated);
                await writable.close();
                if (path === currentFileName) {
                    editor.value = updated;
                    updatePreview();
                }
            } catch (_) { /* skip */ }
        }
    }

    // ── UI Helpers ─────────────────────────────────────

    function showEditor() {
        welcomeScreen.style.display = 'none';
        // Don't show split pane until a file is opened, but we show it if there's already a file
        if (currentFileName) {
            splitPane.classList.remove('hidden');
        }
    }

    async function updatePreview() {
        mermaidIdCounter = 0;
        preview.innerHTML = marked.parse(editor.value || '');
        // Re-highlight any code blocks
        preview.querySelectorAll('pre code').forEach((block) => {
            hljs.highlightElement(block);
        });
        // Render Mermaid diagrams
        await renderMermaidBlocks(preview);
    }

    async function renderMermaidBlocks(container) {
        if (typeof mermaid === 'undefined') return;
        const blocks = container.querySelectorAll('.mermaid-block');
        for (const block of blocks) {
            const id = block.getAttribute('data-mermaid-id') || `mm-${Date.now()}`;
            const definition = block.textContent;
            try {
                const { svg } = await mermaid.render(id, definition);
                block.innerHTML = svg;
                block.classList.add('rendered');
            } catch (err) {
                block.innerHTML = `<pre class="mermaid-error">⚠ Erro no diagrama Mermaid:\n${err.message || err}</pre>`;
                block.classList.add('error');
            }
        }
    }

    function updateFileName() {
        fileName.textContent = currentFileName || '';
    }

    function highlightActiveFile() {
        fileList.querySelectorAll('.file-item').forEach(li => {
            const label = li.querySelector('.file-label');
            if (label && label.getAttribute('title') === currentFileName) {
                li.classList.add('active');
            } else {
                li.classList.remove('active');
            }
        });
        // Show the split pane when a file is opened
        if (currentFileName) {
            splitPane.classList.remove('hidden');
        }
    }

    function setStatus(state) {
        saveStatus.className = 'save-status ' + state;
        const labels = { saved: 'Salvo ✓', saving: 'Salvando...', unsaved: 'Não salvo •' };
        statusText.textContent = labels[state] || 'Pronto';
    }

    // ── Auto-Save ──────────────────────────────────────

    function scheduleAutoSave() {
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        isDirty = true;
        setStatus('unsaved');
        autoSaveTimer = setTimeout(() => {
            saveCurrentFile();
        }, AUTOSAVE_DELAY);
    }

    // ── Auto-Renumber Ordered Lists ──────────────────
    function renumberOrderedLists(text) {
        const lines = text.split('\n');
        let inList = false;
        let counters = {};
        let changed = false;

        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^(\s*)(\d+)(\.)\s/);
            if (match) {
                const indent = match[1];
                const oldNum = parseInt(match[2], 10);

                if (!inList) {
                    counters = {};
                    inList = true;
                }

                if (counters[indent] === undefined) {
                    counters[indent] = 0;
                }

                counters[indent] = counters[indent] + 1;
                const newNum = counters[indent];

                if (oldNum !== newNum) {
                    lines[i] = indent + newNum + lines[i].substring(indent.length + match[2].length);
                    changed = true;
                }
            } else {
                const isBlank = lines[i].trim() === '';
                const isIndentedContent = /^\s+\S/.test(lines[i]) && !/^\s*-\s/.test(lines[i]);

                if (!isBlank && !isIndentedContent) {
                    inList = false;
                    counters = {};
                }
            }
        }

        return changed ? lines.join('\n') : null;
    }

    // ── Toolbar Formatting ─────────────────────────────

    function insertFormatting(action) {
        if (!currentFileHandle) return;
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        const text = editor.value;
        const sel = text.substring(start, end);
        let replacement = '';
        let cursorOffset = 0;

        switch (action) {
            case 'bold':
                replacement = `**${sel || 'texto'}**`;
                cursorOffset = sel ? replacement.length : 2;
                break;
            case 'italic':
                replacement = `_${sel || 'texto'}_`;
                cursorOffset = sel ? replacement.length : 1;
                break;
            case 'strikethrough':
                replacement = `~~${sel || 'texto'}~~`;
                cursorOffset = sel ? replacement.length : 2;
                break;
            case 'heading':
                replacement = `## ${sel || 'Título'}`;
                cursorOffset = replacement.length;
                break;
            case 'code':
                replacement = `\`${sel || 'código'}\``;
                cursorOffset = sel ? replacement.length : 1;
                break;
            case 'codeblock':
                replacement = `\n\`\`\`\n${sel || 'código aqui'}\n\`\`\`\n`;
                cursorOffset = sel ? replacement.length : 5;
                break;
            case 'link':
                replacement = `[${sel || 'texto'}](url)`;
                cursorOffset = sel ? replacement.length - 1 : 1;
                break;
            case 'image':
                replacement = `![${sel || 'alt'}](url)`;
                cursorOffset = sel ? replacement.length - 1 : 2;
                break;
            case 'ul':
                replacement = `- ${sel || 'item'}`;
                cursorOffset = replacement.length;
                break;
            case 'ol':
                replacement = `1. ${sel || 'item'}`;
                cursorOffset = replacement.length;
                break;
            case 'quote':
                replacement = `> ${sel || 'citação'}`;
                cursorOffset = replacement.length;
                break;
            case 'hr':
                replacement = `\n---\n`;
                cursorOffset = replacement.length;
                break;
            case 'table':
                replacement = `\n| Coluna 1 | Coluna 2 | Coluna 3 |\n|----------|----------|----------|\n| célula   | célula   | célula   |\n`;
                cursorOffset = replacement.length;
                break;
            case 'wikilink':
                replacement = `[[${sel || 'Nome da Nota'}]]`;
                cursorOffset = sel ? replacement.length : 2;
                break;
            default:
                return;
        }

        editor.value = text.substring(0, start) + replacement + text.substring(end);
        editor.focus();
        const newPos = start + cursorOffset;
        editor.setSelectionRange(newPos, newPos);
        updatePreview();
        scheduleAutoSave();
    }

    // ── Resize Handle ──────────────────────────────────

    function initResizeHandle() {
        const handle = $('#resize-handle');
        let startX, startWidths;

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            handle.classList.add('dragging');

            startX = e.clientX;
            const editorPane = $('#editor-pane');
            const previewPane = $('#preview-pane');
            startWidths = {
                editor: editorPane.offsetWidth,
                preview: previewPane.offsetWidth
            };

            const onMouseMove = (e) => {
                const dx = e.clientX - startX;
                const totalWidth = startWidths.editor + startWidths.preview;
                const newEditorWidth = Math.max(200, Math.min(totalWidth - 200, startWidths.editor + dx));
                const newPreviewWidth = totalWidth - newEditorWidth;

                splitPane.style.gridTemplateColumns = `${newEditorWidth}px 4px ${newPreviewWidth}px`;
            };

            const onMouseUp = () => {
                handle.classList.remove('dragging');
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    }

    // ── Keyboard Shortcuts ─────────────────────────────

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
            switch (e.key.toLowerCase()) {
                case 's':
                    e.preventDefault();
                    if (currentFileHandle) saveCurrentFile();
                    break;
                case 'b':
                    e.preventDefault();
                    insertFormatting('bold');
                    break;
                case 'i':
                    e.preventDefault();
                    insertFormatting('italic');
                    break;
            }
        }
    });

    // ── Tab Support in Editor ──────────────────────────
    editor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const text = editor.value;

            const lineStart = text.lastIndexOf('\n', start - 1) + 1;
            const lineEnd = text.indexOf('\n', start);
            const lineEndActual = lineEnd === -1 ? text.length : lineEnd;
            const currentLine = text.substring(lineStart, lineEndActual);

            const isListLine = /^\s*(\d+\.\s|- )/.test(currentLine);

            if (e.shiftKey) {
                // Shift+Tab: remove até 2 espaços do início da linha
                const spacesToRemove = currentLine.match(/^( {1,2})/);
                if (spacesToRemove) {
                    const removeCount = spacesToRemove[1].length;
                    editor.value = text.substring(0, lineStart) + currentLine.substring(removeCount) + text.substring(lineEndActual);
                    editor.selectionStart = editor.selectionEnd = Math.max(lineStart, start - removeCount);
                    updatePreview();
                    scheduleAutoSave();
                }
            } else if (isListLine) {
                // Tab em linha de lista: indentar no início da linha
                editor.value = text.substring(0, lineStart) + '  ' + text.substring(lineStart);
                editor.selectionStart = editor.selectionEnd = start + 2;
                updatePreview();
                scheduleAutoSave();
            } else {
                // Tab normal: inserir 2 espaços na posição do cursor
                editor.value = text.substring(0, start) + '  ' + text.substring(end);
                editor.selectionStart = editor.selectionEnd = start + 2;
                updatePreview();
                scheduleAutoSave();
            }
        }
    });

    // ── List Auto-Continue on Enter ──────────────────
    editor.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;

        const start = editor.selectionStart;
        const text = editor.value;

        // Encontrar a linha atual
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const currentLine = text.substring(lineStart, start);

        // Verificar lista ordenada: espaços opcionais + número + ". " + conteúdo
        const olMatch = currentLine.match(/^(\s*)(\d+)\.\s(.*)$/);
        // Verificar lista não-ordenada: espaços opcionais + "- " + conteúdo
        const ulMatch = currentLine.match(/^(\s*)-\s(.*)$/);

        if (olMatch) {
            e.preventDefault();
            const [, indent, numStr, content] = olMatch;
            if (content.trim() === '') {
                // Item vazio — remover prefixo (parar a lista)
                const prefixLen = indent.length + numStr.length + 2;
                editor.value = text.substring(0, lineStart) + text.substring(lineStart + prefixLen);
                editor.selectionStart = editor.selectionEnd = lineStart;
            } else {
                // Continuar numeração
                const nextNum = parseInt(numStr, 10) + 1;
                const insertion = `\n${indent}${nextNum}. `;
                editor.value = text.substring(0, start) + insertion + text.substring(start);
                editor.selectionStart = editor.selectionEnd = start + insertion.length;
            }
            updatePreview();
            scheduleAutoSave();
            return;
        }

        if (ulMatch) {
            e.preventDefault();
            const [, indent, content] = ulMatch;
            if (content.trim() === '') {
                // Item vazio — remover prefixo (parar a lista)
                const prefixLen = indent.length + 2;
                editor.value = text.substring(0, lineStart) + text.substring(lineStart + prefixLen);
                editor.selectionStart = editor.selectionEnd = lineStart;
            } else {
                // Continuar com dash
                const insertion = `\n${indent}- `;
                editor.value = text.substring(0, start) + insertion + text.substring(start);
                editor.selectionStart = editor.selectionEnd = start + insertion.length;
            }
            updatePreview();
            scheduleAutoSave();
            return;
        }
    });

    // ── Event Listeners ────────────────────────────────

    // Open folder
    btnOpenFolder.addEventListener('click', openDirectory);
    btnWelcomeOpen.addEventListener('click', openDirectory);

    // Editor input
    editor.addEventListener('input', () => {
        // Renumerar listas ordenadas automaticamente
        const renumbered = renumberOrderedLists(editor.value);
        if (renumbered !== null) {
            const pos = editor.selectionStart;
            const oldLen = editor.value.length;
            editor.value = renumbered;
            const diff = renumbered.length - oldLen;
            editor.selectionStart = editor.selectionEnd = Math.max(0, pos + diff);
        }
        updatePreview();
        scheduleAutoSave();
    });

    // Wikilink navigation in preview
    preview.addEventListener('click', (e) => {
        const link = e.target.closest('[data-wikilink]');
        if (!link) return;
        e.preventDefault();
        const target = link.getAttribute('data-wikilink');
        if (!target) return;
        const handle = fileHandleMap[target] || null;
        if (handle) {
            openFileByPath(target, handle);
            return;
        }
        // Try searching by title match
        for (const [path, h] of Object.entries(fileHandleMap)) {
            const name = path.split('/').pop().replace(/\.md$/i, '');
            if (name === target) {
                openFileByPath(path, h);
                return;
            }
        }
        // Target doesn't exist — offer to create
        if (confirm(`"${target}" não existe. Criar este arquivo?`)) {
            createFile(target + '.md');
        }
    });

    // Toolbar buttons
    document.querySelectorAll('.tool-btn[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            insertFormatting(btn.dataset.action);
        });
    });

    // New file modal
    btnNewFile.addEventListener('click', () => {
        if (!dirHandle) {
            openDirectory();
            return;
        }
        newFileInput.value = '';
        modalOverlay.classList.remove('hidden');
        setTimeout(() => newFileInput.focus(), 100);
    });

    modalCancel.addEventListener('click', () => {
        modalOverlay.classList.add('hidden');
    });

    modalCreate.addEventListener('click', () => {
        const name = newFileInput.value.trim();
        if (name) {
            createFile(name);
            modalOverlay.classList.add('hidden');
        }
    });

    newFileInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            modalCreate.click();
        } else if (e.key === 'Escape') {
            modalCancel.click();
        }
    });

    // Delete modal
    deleteCancel.addEventListener('click', () => {
        deleteOverlay.classList.add('hidden');
        pendingDeleteName = '';
    });

    deleteConfirm.addEventListener('click', () => {
        if (pendingDeleteName) {
            deleteFile(pendingDeleteName);
            pendingDeleteName = '';
        }
        deleteOverlay.classList.add('hidden');
    });

    // Close modals on overlay click
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) modalOverlay.classList.add('hidden');
    });
    deleteOverlay.addEventListener('click', (e) => {
        if (e.target === deleteOverlay) deleteOverlay.classList.add('hidden');
    });

    // Escape to close modals
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            modalOverlay.classList.add('hidden');
            deleteOverlay.classList.add('hidden');
        }
    });

    // ── Export & Preview HTML ──────────────────────────

    function generateFullHtml(bodyContent) {
        return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${currentFileName || 'Preview'}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"><\/script>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #ffffff;
      color: #1f2328;
      padding: 40px;
      max-width: 900px;
      margin: 0 auto;
      line-height: 1.7;
      font-size: 15px;
      -webkit-font-smoothing: antialiased;
    }
    h1, h2, h3, h4, h5, h6 { margin-top: 24px; margin-bottom: 16px; font-weight: 600; line-height: 1.25; color: #1f2328; }
    h1 { font-size: 2em; padding-bottom: 10px; border-bottom: 1px solid #d1d9e0; }
    h2 { font-size: 1.5em; padding-bottom: 8px; border-bottom: 1px solid #d1d9e0; }
    h3 { font-size: 1.25em; }
    p { margin-bottom: 16px; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    strong { font-weight: 600; }
    code {
      background: #eff1f3; padding: 2px 6px; border-radius: 4px;
      font-family: 'JetBrains Mono', monospace; font-size: 0.9em; color: #cf222e;
    }
    pre {
      background: #f6f8fa; border: 1px solid #d1d9e0; border-radius: 8px;
      padding: 16px; overflow-x: auto; margin-bottom: 16px;
    }
    pre code { background: transparent; padding: 0; color: #1f2328; font-size: 13px; line-height: 1.6; }
    blockquote {
      border-left: 3px solid #0969da; padding: 4px 16px; margin: 0 0 16px;
      color: #59636e; background: #f6f8fa; border-radius: 0 6px 6px 0;
    }
    ul, ol { padding-left: 24px; margin-bottom: 16px; }
    li { margin-bottom: 4px; }
    hr { border: none; height: 1px; background: #d1d9e0; margin: 24px 0; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { border: 1px solid #d1d9e0; padding: 8px 12px; text-align: left; }
    th { background: #f6f8fa; font-weight: 600; }
    tr:nth-child(even) { background: #f6f8fa; }
    img { max-width: 100%; border-radius: 8px; margin: 8px 0; }
    .mermaid-block { margin: 16px 0; display: flex; justify-content: center; }
    .mermaid-block svg { max-width: 100%; height: auto; }
    .mermaid-error { color: #cf222e; font-size: 13px; }
    input[type="checkbox"] { margin-right: 6px; accent-color: #0969da; }
  </style>
</head>
<body>
  ${bodyContent}
  <script>
    mermaid.initialize({ startOnLoad: false, theme: 'default' });
    document.querySelectorAll('.mermaid-block').forEach(async (block, i) => {
      const id = 'mm-export-' + i;
      const definition = block.textContent;
      try {
        const { svg } = await mermaid.render(id, definition);
        block.innerHTML = svg;
      } catch (e) {
        block.innerHTML = '<pre class="mermaid-error">⚠ ' + e.message + '</pre>';
      }
    });
    document.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
  <\/script>
</body>
</html>`;
    }

    function exportHtml() {
        const bodyContent = marked.parse(editor.value || '');
        const fullHtml = generateFullHtml(bodyContent);
        const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (currentFileName || 'document').replace(/\.md$/i, '') + '.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function previewHtml() {
        mermaidIdCounter = 0;
        const bodyContent = marked.parse(editor.value || '');
        const fullHtml = generateFullHtml(bodyContent);
        const win = window.open('', '_blank');
        if (win) {
            win.document.open();
            win.document.write(fullHtml);
            win.document.close();
        }
    }

    // Export / Preview buttons
    btnExportHtml.addEventListener('click', exportHtml);
    btnPreviewHtml.addEventListener('click', previewHtml);

    // ── Initialize ─────────────────────────────────────
    initResizeHandle();

    // Check API support
    if (!('showDirectoryPicker' in window)) {
        btnOpenFolder.disabled = true;
        btnWelcomeOpen.disabled = true;
        const warn = document.createElement('p');
        warn.style.cssText = 'color: #f85149; text-align: center; margin-top: 12px; font-size: 13px;';
        warn.textContent = '⚠ Seu navegador não suporta a File System Access API. Use Chrome ou Edge.';
        document.querySelector('.welcome-content').appendChild(warn);
    }

})();
