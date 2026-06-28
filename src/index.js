export default {
	async fetch(request, env) {
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		};

		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		if (request.method !== "POST") {
			return new Response("Kirim request dengan metode POST dan body JSON.", {
				status: 405,
				headers: corsHeaders
			});
		}

		try {
			const { message, history = [] } = await request.json();

			if (!message || typeof message !== "string" || !message.trim()) {
				return new Response(JSON.stringify({ error: "Pesan tidak boleh kosong" }), {
					status: 400,
					headers: { ...corsHeaders, "Content-Type": "application/json" }
				});
			}

			const cleanMessage = message.trim();

			// === 1. SHORTCUT UNTUK SAPAAN SINGKAT ===
			// Kalau cuma menyapa, jawab instan TANPA panggil AI sama sekali.
			// Ini paling efektif untuk kecepatan karena 0ms inference time.
			const greetingReply = getGreetingShortcut(cleanMessage);
			if (greetingReply) {
				return new Response(JSON.stringify({ response: greetingReply }), {
					headers: { ...corsHeaders, "Content-Type": "application/json" }
				});
			}

			// === 2. MODEL & SYSTEM PROMPT ===
			// Model lebih baru & versi "fast" -> lebih nurut instruksi + latency rendah
			// dibanding mistral-7b-instruct-v0.1 yang lama.
			const model = "@cf/meta/llama-3.1-8b-instruct-fast";

			const systemPrompt = `Kamu adalah AI Maru, asisten chatbot berbahasa Indonesia yang ramah, santai, dan to the point.

ATURAN PANJANG JAWABAN (WAJIB DIIKUTI):
- Sapaan / basa-basi singkat ("hai", "apa kabar", "siapa kamu") -> balas 1 kalimat saja.
- Pertanyaan singkat / butuh jawaban faktual cepat (ya/tidak, definisi singkat, angka) -> 1-3 kalimat, langsung ke jawaban.
- Permintaan penjelasan, tutorial, perbandingan, atau topik teknis -> jawaban detail, terstruktur (gunakan list/numbering bila relevan), TANPA basa-basi pembuka seperti "Tentu, saya akan menjelaskan...". Langsung masuk ke isi.
- Jangan mengulang pertanyaan pengguna sebelum menjawab.
- Jangan menambahkan kalimat penutup generik seperti "Apakah ada yang bisa saya bantu lagi?" kecuali pengguna terlihat baru memulai percakapan.
- Jangan pernah membahas topik di luar yang ditanyakan (misalnya jangan otomatis menjelaskan API kalau tidak diminta).

ATURAN FORMAT LIST (WAJIB DIIKUTI):
- Saat membuat list/poin-poin, JANGAN gunakan simbol generik seperti "-", "*", "•", atau angka biasa "1." "2.".
- Gunakan emoji/icon yang relevan dengan makna tiap poin sebagai bullet, dipilih berdasarkan konteks isi poin tersebut (bukan asal-asalan atau diulang sama semua).
- Pilih icon yang benar-benar mencerminkan isi poin. Contoh pemetaan konteks -> icon (sesuaikan, jangan dihardcode kalau ada yang lebih pas):
  - Langkah/tahapan berurutan -> 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣
  - Kelebihan/hal positif -> ✅ atau 👍
  - Kekurangan/peringatan/risiko -> ⚠️ atau ❌
  - Tips/saran -> 💡
  - Kecepatan/performa -> ⚡
  - Keamanan -> 🔒
  - Biaya/harga -> 💰
  - Waktu -> ⏱️
  - Fitur/komponen teknis -> 🔧 ⚙️
  - Dokumen/data -> 📄 📊
  - Penting/perhatian khusus -> 📌 ❗
- Setiap poin dalam satu list idealnya pakai icon yang BERBEDA-BEDA sesuai makna poinnya masing-masing, bukan icon yang sama diulang terus untuk semua poin (kecuali memang itu list tahapan berurutan, baru pakai angka bernomor emoji 1️⃣2️⃣3️⃣).
- Tetap rapi: satu icon di awal baris, lalu spasi, lalu teks poin. Jangan berlebihan menaruh banyak emoji dalam satu baris.
- Aturan ini hanya berlaku untuk list/poin-poin. Untuk paragraf biasa, tidak perlu pakai icon.

Jawab selalu dalam Bahasa Indonesia kecuali pengguna menulis dalam bahasa lain.`;

			// === 3. SUSUN MESSAGES ===
			// Few-shot dipangkas jadi 1 contoh representatif saja (bukan 3 pasang)
			// supaya payload lebih kecil -> request lebih cepat.
			// `history` opsional dari frontend (riwayat chat user-assistant sebelumnya),
			// dipotong maksimal 6 message terakhir biar konteks tidak membengkak.
			const trimmedHistory = Array.isArray(history) ? history.slice(-6) : [];

			const messages = [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: "jelaskan cara kerja API" },
				{
					role: "assistant",
					content:
						"API menghubungkan dua aplikasi untuk bertukar data lewat 3 langkah:\n\n1️⃣ Request: klien mengirim permintaan ke server.\n2️⃣ Proses: server mengambil data dari database.\n3️⃣ Response: server mengembalikan data ke klien, biasanya format JSON.\n\n💡 Tips: pakai format JSON karena lebih ringan dan mudah diparsing dibanding XML."
				},
				...trimmedHistory,
				{ role: "user", content: cleanMessage }
			];

			// === 4. PANGGIL AI ===
			// max_tokens dibatasi supaya model tidak melebar ke topik lain / mengulang-ulang.
			// temperature rendah-menengah supaya jawaban tetap konsisten & tidak ngelantur.
			const aiResponse = await env.AI.run(model, {
				messages,
				max_tokens: 512,
				temperature: 0.4
			});

			const finalResult = {
				response: aiResponse.response || aiResponse
			};

			return new Response(JSON.stringify(finalResult), {
				headers: { ...corsHeaders, "Content-Type": "application/json" }
			});

		} catch (error) {
			return new Response(JSON.stringify({ error: error.toString() }), {
				status: 500,
				headers: { ...corsHeaders, "Content-Type": "application/json" }
			});
		}
	}
};

/**
 * Cek apakah pesan termasuk sapaan singkat / small talk umum.
 * Kalau iya, kembalikan balasan instan tanpa perlu memanggil model AI.
 * Return null kalau bukan sapaan (lanjut ke pemanggilan AI seperti biasa).
 */
function getGreetingShortcut(text) {
	const normalized = text.toLowerCase().trim().replace(/[!?.,]/g, "");

	const greetingMap = {
		"hi": "Halo! Ada yang bisa aku bantu?",
		"hai": "Halo! Ada yang bisa aku bantu?",
		"halo": "Halo! Ada yang bisa aku bantu?",
		"hello": "Halo! Ada yang bisa aku bantu?",
		"hey": "Halo! Ada yang bisa aku bantu?",
		"p": "Ya, ada yang bisa dibantu?",
		"woi": "Halo! Ada yang bisa aku bantu?",
		"selamat pagi": "Selamat pagi! Ada yang bisa aku bantu?",
		"selamat siang": "Selamat siang! Ada yang bisa aku bantu?",
		"selamat sore": "Selamat sore! Ada yang bisa aku bantu?",
		"selamat malam": "Selamat malam! Ada yang bisa aku bantu?",
		"apa kabar": "Baik! Ada yang bisa aku bantu hari ini?",
		"kamu siapa": "Aku AI Maru, asisten virtual yang siap membantu kebutuhanmu.",
		"siapa kamu": "Aku AI Maru, asisten virtual yang siap membantu kebutuhanmu.",
		"kamu siapa?": "Aku AI Maru, asisten virtual yang siap membantu kebutuhanmu.",
		"makasih": "Sama-sama! Ada lagi yang bisa aku bantu?",
		"terima kasih": "Sama-sama! Ada lagi yang bisa aku bantu?",
		"thanks": "Sama-sama! Ada lagi yang bisa aku bantu?"
	};

	return greetingMap[normalized] || null;
}