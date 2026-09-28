const { 
    Client, 
    GatewayIntentBits, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    AttachmentBuilder, 
    EmbedBuilder 
} = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Jimp = require('jimp');
const fs = require('fs');
const path = require('path');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const CREATOR_ID = '1179808811494690889';
const ALLOWED_ROLE_ID = '1553818141157757109';

// State Management
const userSessions = new Map();
const chatlogSessions = new Map(); 
const aiMemories = new Map(); 
const filePath = path.join(__dirname, 'active_channels.json');

function loadActiveChannels() {
    try { if (fs.existsSync(filePath)) return new Set(JSON.parse(fs.readFileSync(filePath, 'utf8'))); } 
    catch (e) {} return new Set();
}

function saveActiveChannels(channelsSet) {
    try { fs.writeFileSync(filePath, JSON.stringify([...channelsSet]), 'utf8'); } 
    catch (e) {}
}
const activeChannels = loadActiveChannels();

client.once('ready', () => console.log(`Bot Velocity Elite Club (AI & SSRP Pro HD) online!`));

async function generateWithRetry(model, chatPrompt, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const result = await model.generateContent(chatPrompt);
            return await result.response;
        } catch (error) {
            if (error.message.includes('503') && i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
                continue;
            }
            throw error;
        }
    }
}

function getCleanName(displayName) {
    if (displayName.includes('||')) return displayName.split('||').pop().trim();
    return displayName.trim();
}

// --- FUNGSI RENDER GAMBAR SSRP (TEKS RAPI & ANTI-NYAMBUNG) ---
async function renderImage(session, isPreview = true) {
    let sourceBuffer = isPreview ? session.previewBuffer : session.imageBuffer;
    let image = await Jimp.read(sourceBuffer);
    
    image.crop(session.vpX, session.vpY, session.vpW, session.vpH);
    image.resize(800, 600);

    if (session.filter === 'grayscale') image.greyscale();
    else if (session.filter === 'vibrant') image.color([{ apply: 'brighten', params: [10] }, { apply: 'saturate', params: [20] }]);
    else if (session.filter === 'dark') image.color([{ apply: 'darken', params: [15] }, { apply: 'desaturate', params: [10] }]);

    const font = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE); 
    
    for (const block of session.blocks) {
        const lines = block.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let totalTextHeight = 0;
        for (const line of lines) totalTextHeight += Jimp.measureTextHeight(font, line, 800) + 2;

        let currentY = 25; 
        if (block.pos.includes('bottom')) currentY = 600 - totalTextHeight - 25; 

        for (const line of lines) {
            const isAction = line.startsWith('*');
            const tWidth = Jimp.measureText(font, line);
            const tHeight = Jimp.measureTextHeight(font, line, 800);
            
            let startX = 25; 
            if (block.pos.includes('right')) startX = 800 - tWidth - 25; 

            // Render Stroke Hitam Terpisah (Anti-Nyambung)
            const strokeLayer = new Jimp(tWidth + 4, tHeight + 4, 0x00000000);
            strokeLayer.print(font, 0, 2, line)
                       .print(font, 4, 2, line)
                       .print(font, 2, 0, line)
                       .print(font, 2, 4, line);
            
            strokeLayer.scan(0, 0, strokeLayer.bitmap.width, strokeLayer.bitmap.height, function(x, y, idx) {
                if (this.bitmap.data[idx+3] > 0) {
                    this.bitmap.data[idx] = 0; 
                    this.bitmap.data[idx+1] = 0; 
                    this.bitmap.data[idx+2] = 0;
                }
            });

            const textLayer = new Jimp(tWidth + 4, tHeight + 4, 0x00000000);
            textLayer.print(font, 2, 2, line);
            
            if (isAction) {
                textLayer.scan(0, 0, textLayer.bitmap.width, textLayer.bitmap.height, function(x, y, idx) {
                    if (this.bitmap.data[idx+3] > 0) {
                        this.bitmap.data[idx] = 194; 
                        this.bitmap.data[idx+1] = 162; 
                        this.bitmap.data[idx+2] = 218; 
                    }
                });
            }

            image.composite(strokeLayer, startX - 2, currentY - 2);
            image.composite(textLayer, startX - 2, currentY - 2);

            currentY += tHeight + 2; 
        }
    }

    if (isPreview) {
        image.resize(400, 300);
        image.quality(70);
    }
    return await image.getBufferAsync(Jimp.MIME_PNG);
}

// --- UI UPDATE FUNCTIONS ---
async function updateChatlogsPanel(interaction, session) {
    const embed = new EmbedBuilder()
        .setTitle('🧹 AI Chatlogs Extractor')
        .setDescription(`**Setup Ekstraksi:**\n🗣️ Filter Bahasa: \`${session.lang === 'all' ? 'Semua' : (session.lang === 'id' ? 'Indonesia' : 'Inggris')}\`\n📏 Jumlah Baris per blok: \`${session.lines}\` baris.\n\nJika sudah pas, klik **Upload File Chatlog**!`)
        .setColor(0x00FF00);

    const rowLang = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('clog_lang').setPlaceholder('🗣️ Pilih Filter Bahasa (AI)...').addOptions([
            { label: 'Semua Bahasa (Tanpa Filter AI)', value: 'all' },
            { label: 'Fokus Bahasa Indonesia', value: 'id' },
            { label: 'Fokus Bahasa Inggris', value: 'en' }
        ])
    );

    const rowLines = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('clog_lines').setPlaceholder('📏 Pilih Jumlah Baris Per Blok...').addOptions([
            { label: '5 Baris per blok', value: '5' }, { label: '10 Baris per blok', value: '10' },
            { label: '15 Baris per blok', value: '15' }, { label: '20 Baris per blok', value: '20' }
        ])
    );

    const rowBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('clog_upload').setLabel('📤 Upload File Chatlog').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('clog_cancel').setLabel('Batal').setStyle(ButtonStyle.Danger)
    );

    const payload = { embeds: [embed], components: [rowLang, rowLines, rowBtn] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.update(payload);
}

async function updateInitialPanel(interaction, session) {
    let blocksDesc = session.blocks.length === 0 ? "Belum ada teks." : session.blocks.map((b, i) => `**Blok ${i+1} (${b.pos}):**\n\`\`\`\n${b.text}\n\`\`\``).join('\n');
    const embed = new EmbedBuilder().setTitle('✨ SSRP Builder Pro (Setup)').setDescription(`**Daftar Chatlog Anda:**\n${blocksDesc}\n\n1. Tambahkan Chatlog di posisi yang diinginkan.\n2. Klik **Upload Foto Mentah** jika sudah selesai.`).setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_add_block').setLabel('📝 Tambah Chatlog').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('btn_req_upload').setLabel('🖼️ Upload Foto Mentah').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_reset_blocks').setLabel('🗑️ Reset Teks').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_cancel').setLabel('✖️ Batal').setStyle(ButtonStyle.Danger)
    );
    const payload = { content: '', embeds: [embed], components: [row] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.update(payload);
}

async function updateStudioUI(interaction, session) {
    const buffer = await renderImage(session, true);
    const previewAttachment = new AttachmentBuilder(buffer, { name: 'preview.png' });
    const embed = new EmbedBuilder().setTitle('🎛️ STUDIO INTERAKTIF SSRP').setDescription('⚠️ *Preview dioptimalkan otomatis. Hasil akhir (Finishing) tetap Ultra HD.*').setColor(0xFFA500).setImage('attachment://preview.png');
    
    const rowPan = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('pan_left').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pan_up').setEmoji('⬆️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pan_down').setEmoji('⬇️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('pan_right').setEmoji('➡️').setStyle(ButtonStyle.Secondary)
    );
    const rowZoom = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('zoom_in').setLabel('Zoom In').setEmoji('⏺️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('zoom_out').setLabel('Zoom Out').setEmoji('🔽').setStyle(ButtonStyle.Primary)
    );
    const rowFilter = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId('select_filter').setPlaceholder('🎨 Pilih Filter Warna Foto...').addOptions([
            { label: 'Original', value: 'original' }, { label: 'Cerah (HDR)', value: 'vibrant' },
            { label: 'Gelap (Cinematic)', value: 'dark' }, { label: 'Hitam Putih (Vintage)', value: 'grayscale' }
        ])
    );
    const rowAction = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_finishing').setLabel('🚀 FINISHING (BUAT SSRP HD)').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_cancel').setLabel('Batal').setStyle(ButtonStyle.Danger)
    );

    const payload = { content: '', embeds: [embed], components: [rowPan, rowZoom, rowFilter, rowAction], files: [previewAttachment] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.update(payload);
}

// --- MAIN LISTENER ---
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content.trim();
    const channelId = message.channel.id;
    const hasRole = message.member && message.member.roles.cache.has(ALLOWED_ROLE_ID);
    const isCreator = message.author.id === CREATOR_ID;

    // --- COMMAND !CHATLOGS ---
    if (content === '!chatlogs') {
        if (!hasRole && !isCreator) return message.reply('Waduh, 🤪 kamu tidak punya izin!');
        chatlogSessions.set(message.author.id, { lang: 'all', lines: 10 });
        
        const embed = new EmbedBuilder()
            .setTitle('🧹 AI Chatlogs Extractor')
            .setDescription('**Setup Ekstraksi:**\n🗣️ Filter Bahasa: `Semua`\n📏 Jumlah Baris: `10` baris.\n\nJika sudah pas, klik **Upload File Chatlog**!')
            .setColor(0x00FF00);

        const rowLang = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('clog_lang').setPlaceholder('🗣️ Pilih Filter Bahasa (AI)...').addOptions([
                { label: 'Semua Bahasa (Tanpa Filter AI)', value: 'all' },
                { label: 'Fokus Bahasa Indonesia', value: 'id' },
                { label: 'Fokus Bahasa Inggris', value: 'en' }
            ])
        );

        const rowLines = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('clog_lines').setPlaceholder('📏 Pilih Jumlah Baris Per Blok...').addOptions([
                { label: '5 Baris per blok', value: '5' }, { label: '10 Baris per blok', value: '10' },
                { label: '15 Baris per blok', value: '15' }, { label: '20 Baris per blok', value: '20' }
            ])
        );

        const rowBtn = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('clog_upload').setLabel('📤 Upload File Chatlog').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('clog_cancel').setLabel('Batal').setStyle(ButtonStyle.Danger)
        );

        return message.reply({ embeds: [embed], components: [rowLang, rowLines, rowBtn] });
    }

    // --- COMMAND !SSRP ---
    if (content === '!ssrp') {
        if (!hasRole && !isCreator) return message.reply('Waduh, 🤪 kamu tidak punya izin!');
        userSessions.set(message.author.id, { blocks: [], tempText: '' });
        
        const embed = new EmbedBuilder().setTitle('✨ SSRP Builder Pro (Setup)').setDescription(`**Daftar Chatlog Anda:**\nBelum ada teks.\n\n1. Tambahkan Chatlog di posisi yang diinginkan.\n2. Klik **Upload Foto Mentah** jika sudah selesai.`).setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('btn_add_block').setLabel('📝 Tambah Chatlog').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('btn_req_upload').setLabel('🖼️ Upload Foto Mentah').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('btn_reset_blocks').setLabel('🗑️ Reset Teks').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('btn_cancel').setLabel('✖️ Batal').setStyle(ButtonStyle.Danger)
        );
        return message.reply({ embeds: [embed], components: [row] });
    }

    // --- AI GEMINI MEMORY CHAT ---
    if (content === '!startai' || content === '!stopai') {
        if (!isCreator) return message.reply('Hanya creator yang bisa mengatur ini!');
        if (content === '!startai') {
            activeChannels.add(channelId); saveActiveChannels(activeChannels);
            aiMemories.set(channelId, []); 
            return message.reply('Bot AI dikunci dan aktif HANYA di channel ini! ✨');
        } else {
            activeChannels.delete(channelId); saveActiveChannels(activeChannels);
            aiMemories.delete(channelId);
            return message.reply('Bot AI dinonaktifkan! 👋');
        }
    }

    if (!activeChannels.has(channelId)) return;
    const isMentioned = message.mentions.users.has(client.user.id);
    const hasAiPrefix = content.startsWith('!ai');
    let promptText = content;
    if (hasAiPrefix) promptText = content.slice(3).trim();
    else if (isMentioned) promptText = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    
    if (!promptText) return;

    try {
        await message.channel.sendTyping();
        let memory = aiMemories.get(channelId) || [];
        const cleanName = getCleanName(message.member ? message.member.displayName : message.author.username);
        memory.push(`${cleanName}: ${promptText}`);
        if (memory.length > 10) memory.shift(); 
        aiMemories.set(channelId, memory);

        const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
        const sys = `Teman nongkrong asik Velocity Elite Club. Panggil nama akrab user (sebelum titik dua). Jangan panggil V-CEO atau pakai ||. Sifat: Santai, gaul (lu/gw), ceplas-ceplos. Creator: ID ${CREATOR_ID}.`;
        const chatPrompt = `${sys}\n\n=== RIWAYAT ===\n${memory.join('\n')}\n\nBalas natural!`;
        
        const response = await generateWithRetry(model, chatPrompt);
        const replyText = response.text().slice(0, 2000);
        memory.push(`Bot: ${replyText}`);
        aiMemories.set(channelId, memory);
        await message.reply(replyText);
    } catch (error) {
        console.error(error);
        if (error.message.includes('503')) await message.reply('Otak AI gw lagi pusing (Server Sibuk) 🥵.');
        else if (error.message.includes('429')) await message.reply('Waduh gw lagi ditanya banyak orang nih (Limit). Santai sebat dulu ☕');
    }
});

// --- INTERAKSI BUTTON & MODAL ---
client.on('interactionCreate', async (interaction) => {
    if (interaction.customId && interaction.customId.startsWith('clog_')) {
        let clSession = chatlogSessions.get(interaction.user.id);
        if (!clSession) return interaction.reply({ content: 'Sesi chatlog habis, ketik `!chatlogs` lagi.', ephemeral: true });

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'clog_lang') clSession.lang = interaction.values[0];
            if (interaction.customId === 'clog_lines') clSession.lines = parseInt(interaction.values[0]);
            chatlogSessions.set(interaction.user.id, clSession);
            return await updateChatlogsPanel(interaction, clSession);
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'clog_cancel') {
                chatlogSessions.delete(interaction.user.id);
                return interaction.update({ content: 'Dibatalkan. ✖️', embeds: [], components: [] });
            }

            if (interaction.customId === 'clog_upload') {
                await interaction.reply({ content: '📂 **Upload file `chatlog.txt` kamu ke sini sekarang!** (Waktu 3 menit)', ephemeral: false });
                const filter = m => m.author.id === interaction.user.id && m.attachments.first() && m.attachments.first().name.endsWith('.txt');
                const collector = interaction.channel.createMessageCollector({ filter, time: 180000, max: 1 });

                collector.on('collect', async (msg) => {
                    await msg.channel.sendTyping();
                    try {
                        const attachment = msg.attachments.first();
                        const response = await fetch(attachment.url);
                        const textData = await response.text();
                        await msg.delete().catch(() => {}); 
                        await interaction.deleteReply().catch(() => {}); 
                        await interaction.message.delete().catch(() => {}); 

                        let lines = textData.split('\n');
                        let cleanedLines = [];

                        for (let line of lines) {
                            line = line.trim();
                            if (!line) continue; 
                            line = line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '');
                            if (line.startsWith('**')) line = '*' + line.substring(2);
                            if (line.endsWith('**')) line = line.substring(0, line.length - 2) + '*';
                            if (line.includes(' says: ') || line.startsWith('* ')) cleanedLines.push(line);
                        }

                        if (cleanedLines.length === 0) return msg.channel.send('⚠️ Tidak ditemukan chat player.');
                        
                        let finalTexts = cleanedLines;

                        if (clSession.lang !== 'all') {
                            const waitMsg = await msg.channel.send('⏳ *AI sedang menyeleksi bahasa chatlog kamu...*');
                            const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });
                            const langName = clSession.lang === 'id' ? 'Indonesia' : 'Inggris';
                            
                            const prompt = `Ini adalah chatlog SA-MP mentah. Tugasmu:
                            1. Filter dan HANYA sisakan baris yang percakapannya menggunakan bahasa ${langName}.
                            2. TETAP pertahankan baris aksi roleplay yang diawali tanda bintang (*).
                            3. JANGAN merubah format, nama karakter, atau menambahkan teks lain. Cukup hapus baris obrolan yang beda bahasa.
                            Teks Chatlog:\n${cleanedLines.join('\n')}`;

                            try {
                                const aiRes = await generateWithRetry(model, prompt);
                                finalTexts = aiRes.text().split('\n').map(l => l.trim()).filter(l => l.length > 0);
                            } catch (e) {
                                await msg.channel.send('⚠️ Filter AI gagal (Server Sibuk), menampilkan semua bahasa.');
                            }
                            await waitMsg.delete().catch(() => {});
                        }
                        
                        await msg.channel.send(`✅ **Ekstraksi Selesai!** (${clSession.lines} baris per blok):`);
                        for (let i = 0; i < finalTexts.length; i += clSession.lines) {
                            const chunk = finalTexts.slice(i, i + clSession.lines).join('\n');
                            const embedChunk = new EmbedBuilder().setDescription(chunk).setColor(0x2B2D31);
                            await msg.channel.send({ embeds: [embedChunk] });
                        }
                        chatlogSessions.delete(interaction.user.id);
                    } catch (err) {
                        await msg.channel.send(`Duh, gagal: \`${err.message}\` 💀`);
                    }
                });
                return;
            }
        }
    }

    let session = userSessions.get(interaction.user.id);
    if (!session && !interaction.customId.startsWith('clog_') && interaction.customId !== 'btn_cancel') return;

    if (interaction.isModalSubmit() && interaction.customId === 'modal_add_block') {
        session.tempText = interaction.fields.getTextInputValue('input_text');
        userSessions.set(interaction.user.id, session);
        
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('select_pos_new_block').setPlaceholder('📍 Pilih Posisi untuk teks barusan...').addOptions([
                { label: 'Kiri Atas', value: 'top-left' }, { label: 'Kiri Bawah', value: 'bottom-left' },
                { label: 'Kanan Atas', value: 'top-right' }, { label: 'Kanan Bawah', value: 'bottom-right' }
            ])
        );
        const replyData = { content: 'Teks disimpan! Pilih posisinya:', embeds: [], components: [row], ephemeral: true };
        if (interaction.message) return interaction.update(replyData);
        return interaction.reply(replyData);
    }

    if (interaction.isStringSelectMenu()) {
        if (interaction.customId === 'select_pos_new_block') {
            session.blocks.push({ text: session.tempText, pos: interaction.values[0] });
            session.tempText = '';
            userSessions.set(interaction.user.id, session);
            
            if (session.imageBuffer) return await updateStudioUI(interaction, session);
            return await updateInitialPanel(interaction, session);
        }

        if (interaction.customId === 'select_filter') {
            await interaction.deferUpdate(); 
            session.filter = interaction.values[0];
            userSessions.set(interaction.user.id, session);
            return await updateStudioUI(interaction, session);
        }
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'btn_cancel') {
            userSessions.delete(interaction.user.id);
            return interaction.update({ content: 'Proses dibatalkan. ✖️', embeds: [], components: [], files: [] });
        }

        if (interaction.customId === 'btn_reset_blocks') {
            session.blocks = [];
            userSessions.set(interaction.user.id, session);
            if (session.imageBuffer) return await updateStudioUI(interaction, session);
            return await updateInitialPanel(interaction, session);
        }

        if (interaction.customId === 'btn_add_block') {
            const modal = new ModalBuilder().setCustomId('modal_add_block').setTitle('Masukkan Teks Chatlog');
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('input_text').setLabel('Tulis chatlog (Enter untuk baris baru):').setStyle(TextInputStyle.Paragraph).setRequired(true)
            ));
            return await interaction.showModal(modal);
        }

        if (interaction.customId === 'btn_req_upload') {
            if (session.blocks.length === 0) return interaction.reply({ content: '⚠️ Kamu belum mengisi teks chatlog!', ephemeral: true });
            
            await interaction.reply({ content: '📸 **Silakan upload FOTO MENTAH kamu ke chat ini sekarang!** Waktu 3 menit.', ephemeral: false });

            const filter = m => m.author.id === interaction.user.id && m.attachments.first() && m.attachments.first().contentType.startsWith('image/');
            const collector = interaction.channel.createMessageCollector({ filter, time: 180000, max: 1 });

            collector.on('collect', async (msg) => {
                await msg.channel.sendTyping();
                const attachment = msg.attachments.first();
                
                await msg.delete().catch(() => {});
                await interaction.deleteReply().catch(() => {});
                await interaction.message.delete().catch(() => {});

                let optimizedUrl = attachment.url.replace('cdn.discordapp.com', 'media.discordapp.net');
                optimizedUrl = `${optimizedUrl}?width=1280&height=960`;

                const previewRes = await fetch(optimizedUrl);
                const previewBuf = await previewRes.arrayBuffer();
                session.previewBuffer = Buffer.from(previewBuf);

                const origRes = await fetch(attachment.url);
                const origBuf = await origRes.arrayBuffer();
                session.imageBuffer = Buffer.from(origBuf);

                const originalImage = await Jimp.read(session.imageBuffer);
                const origW = originalImage.bitmap.width; 
                const origH = originalImage.bitmap.height;

                let vpW = Math.min(origW, Math.floor(origH * (800/600)));
                let vpH = Math.floor(vpW * (600/800));
                let vpX = Math.floor((origW - vpW) / 2);
                let vpY = Math.floor((origH - vpH) / 2);

                session.origW = origW; session.origH = origH;
                session.vpX = vpX; session.vpY = vpY;
                session.vpW = vpW; session.vpH = vpH;
                session.filter = 'original';

                userSessions.set(interaction.user.id, session);
                await updateStudioUI(interaction, session);
            });
            return;
        }

        if (['pan_left', 'pan_right', 'pan_up', 'pan_down', 'zoom_in', 'zoom_out'].includes(interaction.customId)) {
            await interaction.deferUpdate(); 
            const stepX = Math.floor(session.vpW * 0.1); 
            const stepY = Math.floor(session.vpH * 0.1);
            
            if (interaction.customId === 'pan_left') session.vpX = Math.max(0, session.vpX - stepX);
            if (interaction.customId === 'pan_right') session.vpX = Math.min(session.origW - session.vpW, session.vpX + stepX);
            if (interaction.customId === 'pan_up') session.vpY = Math.max(0, session.vpY - stepY);
            if (interaction.customId === 'pan_down') session.vpY = Math.min(session.origH - session.vpH, session.vpY + stepY);
            
            if (interaction.customId === 'zoom_in') {
                const newW = Math.floor(session.vpW * 0.8); const newH = Math.floor(session.vpH * 0.8);
                session.vpX += Math.floor((session.vpW - newW) / 2); session.vpY += Math.floor((session.vpH - newH) / 2);
                session.vpW = newW; session.vpH = newH;
            }
            if (interaction.customId === 'zoom_out') {
                const newW = Math.floor(session.vpW * 1.25); const newH = Math.floor(session.vpH * 1.25);
                session.vpX -= Math.floor((newW - session.vpW) / 2); session.vpY -= Math.floor((newH - session.vpH) / 2);
                session.vpW = newW; session.vpH = newH;
            }

            session.vpX = Math.max(0, Math.min(session.origW - session.vpW, session.vpX));
            session.vpY = Math.max(0, Math.min(session.origH - session.vpH, session.vpY));
            if (session.vpW > session.origW) { session.vpW = session.origW; session.vpX = 0; }
            if (session.vpH > session.origH) { session.vpH = session.origH; session.vpY = 0; }

            userSessions.set(interaction.user.id, session);
            return await updateStudioUI(interaction, session);
        }

        if (interaction.customId === 'btn_finishing') {
            await interaction.deferUpdate();
            await interaction.editReply({ content: '⏳ *Sedang merender Ultra HD (Finishing)...*', embeds: [], components: [], files: [] });

            try {
                const finalBuffer = await renderImage(session, false);
                const resultAttachment = new AttachmentBuilder(finalBuffer, { name: 'ssrp_final_hd.png' });

                await interaction.message.delete().catch(() => {});
                await interaction.channel.send({ content: `✅ **Selesai!** Ini hasil SSRP Ultra HD jernih kamu, <@${interaction.user.id}> 📸✨`, files: [resultAttachment] });
                userSessions.userSessions?.delete(interaction.user.id);
                userSessions.delete(interaction.user.id);
            } catch (err) {
                await interaction.channel.send(`Duh, gagal merender hasil final: \`${err.message}\` 💀`);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN_AI);
