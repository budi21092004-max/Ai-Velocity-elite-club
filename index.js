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
const sharp = require('sharp'); 
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

// Ubah event ready ke clientReady agar warning hilang
client.once('clientReady', () => console.log(`Bot Velocity Elite Club (AI & SSRP Sharp-Engine) online!`));

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

// --- FUNGSI RENDER GAMBAR SSRP (SHARP ENGINE) ---
async function renderImage(session, isPreview = true) {
    let sourceBuffer = session.imageBuffer;
    
    let imageObj = sharp(sourceBuffer).extract({ 
        left: session.vpX, 
        top: session.vpY, 
        width: session.vpW, 
        height: session.vpH 
    }).resize(800, 600); 

    switch (session.filter) {
        case 'grayscale': 
            imageObj = imageObj.grayscale(); 
            break;
        case 'vibrant': 
            imageObj = imageObj.modulate({ brightness: 1.1, saturation: 1.2 }); 
            break;
        case 'dark': 
            imageObj = imageObj.modulate({ brightness: 0.85, saturation: 0.9 }); 
            break;
        default: 
            break;
    }

    let svgTexts = '';
    const lineHeight = 22;
    const marginX = 25;
    const marginBottom = 25;
    const canvasWidth = 800;
    const canvasHeight = 600;

    const yPositions = {
        'top-left': marginBottom + 15,
        'bottom-left': canvasHeight - marginBottom,
        'top-right': marginBottom + 15,
        'bottom-right': canvasHeight - marginBottom
    };

    for (const block of session.blocks) {
        const pos = block.pos;
        const lines = block.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let yStart = yPositions[pos] ?? marginBottom;

        if (pos.includes('bottom')) {
            yStart -= (lines.length * lineHeight);
        }

        const xStart = pos.includes('right') ? canvasWidth - marginX : marginX;
        
        lines.forEach((line, i) => {
            const fillCol = line.startsWith('*') ? '#C2A2DA' : '#FFFFFF';
            const textAnchor = pos.includes('right') ? 'end' : 'start';
            const safeLine = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            
            svgTexts += `<text x="${xStart}" y="${yStart + (i * lineHeight)}" font-family="Arial, sans-serif" font-size="16" font-weight="bold" fill="${fillCol}" stroke="black" stroke-width="2" paint-order="stroke" text-anchor="${textAnchor}">${safeLine}</text>\n`;
        });
    }

    if (session.blocks.length > 0) {
        const svgImage = `<svg width="${canvasWidth}" height="${canvasHeight}">${svgTexts}</svg>`;
        const svgBuffer = Buffer.from(svgImage);
        imageObj = imageObj.composite([{ input: svgBuffer, blend: 'over' }]);
    }

    if (isPreview) {
        imageObj = imageObj.resize(400, 300);
    }

    return await imageObj.png({ quality: isPreview ? 70 : 100 }).toBuffer();
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
    try {
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
    } catch (error) {
        console.error(error);
        const errPayload = { content: '⚠️ Gagal me-render preview gambar. Coba upload ulang foto mentahnya.', embeds: [], components: [] };
        if (interaction.deferred || interaction.replied) await interaction.editReply(errPayload);
        else await interaction.reply(errPayload);
    }
}

// --- MAIN LISTENER ---
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content.trim();
    const channelId = message.channel.id;
    const hasRole = message.member && message.member.roles.cache.has(ALLOWED_ROLE_ID);
    const isCreator = message.author.id === CREATOR_ID;

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
    else if (isMentioned) promptText = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    
    if (!promptText) return;

    try {
        await message.channel.sendTyping();
        let memory = aiMemories.get(channelId) || [];
        const cleanName = getCleanName(message.member ? message.member.displayName : message.author.username);
        memory.push(`${cleanName}: ${promptText}`);
        if (memory.length > 10) memory.shift(); 
        aiMemories.set(channelId, memory);

        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const sys = `Teman nongkrong asik Velocity Elite Club. Panggil nama akrab user (sebelum titik dua). Jangan panggil V-CEO atau pakai ||. Sifat: Santai, gaul (lu/gw), ceplas-ceplos. Creator: ID ${CREATOR_ID}.`;
        const chatPrompt = `${sys}\n\n=== RIWAYAT ===\n${memory.join('\n')}\n\nBalas natural!`;
        
        const response = await generateWithRetry(model, chatPrompt);
        const replyText = response.text().slice(0, 2000);
        memory.push(`Bot: ${replyText}`);
        aiMemories.set(channelId, memory);
        await message.reply(replyText);
    } catch (error) {
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
                            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
                            const langName = clSession.lang === 'id' ? 'Indonesia' : 'Inggris';
                            
                            const prompt = `Filter chatlog SA-MP ini. Hanya ambil baris berbahasa ${langName} dan baris aksi (*). Jangan ubah format, cukup hapus baris obrolan yang beda bahasa. Teks:\n${cleanedLines.join('\n')}`;

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
            let activeSession = userSessions.get(interaction.user.id);
            if (activeSession) {
                activeSession.imageBuffer = null;
            }
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
                
                try {
                    const attachment = msg.attachments.first();
                    
                    await msg.delete().catch(() => {});
                    await interaction.deleteReply().catch(() => {});
                    await interaction.message.delete().catch(() => {});

                    // PENANGANAN ERROR DOWNLOAD GAMBAR (Mencegah buffer kosong/crash)
                    const origRes = await fetch(attachment.url);
                    if (!origRes.ok) throw new Error("Gagal mengunduh gambar dari Discord.");
                    
                    const origBuf = await origRes.arrayBuffer();
                    session.imageBuffer = Buffer.from(origBuf);

                    const metadata = await sharp(session.imageBuffer).metadata();
                    const origW = metadata.width; 
                    const origH = metadata.height;

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

                } catch (error) {
                    console.error("Gagal saat memproses upload:", error);
                    await msg.channel.send(`⚠️ Terjadi kendala saat memproses gambar: \`${error.message}\`. Silakan klik upload ulang.`);
                }
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
                
                let activeSession = userSessions.get(interaction.user.id);
                if (activeSession) {
                    activeSession.imageBuffer = null;
                }
                userSessions.delete(interaction.user.id);
            } catch (err) {
                await interaction.channel.send(`Duh, gagal merender hasil final: \`${err.message}\` 💀`);
            }
        }
    }
});

client.login(process.env.DISCORD_TOKEN_AI);
