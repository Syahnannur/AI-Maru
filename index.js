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
			// Dikirim sebagai SSE juga supaya frontend tidak perlu cabang logika
			// terpisah untuk "instant reply" vs "streamed reply".
			const greetingReply = getGreetingShortcut(cleanMessage);
			if (greetingReply) {
				return streamPlainText(greetingReply, corsHeaders);
			}

			// === 2. MODEL & SYSTEM PROMPT ===
			// Llama 3.3 70B (fp8, varian -fast): jauh lebih pintar di reasoning,
			// instruction-following, dan bahasa Indonesia dibanding Llama 3.1 8B,
			// sambil tetap dipercepat lewat speculative decoding di sisi Cloudflare.
			// Context window 24K token jadi cukup leluasa untuk history panjang.
			const model = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

			const systemPrompt = `Kamu adalah AI Orcaku, asisten chatbot berbahasa Indonesia yang ramah, santai, to the point, dan CERDAS — kamu menjawab dengan pemahaman mendalam, bukan sekadar template.

ATURAN PANJANG JAWABAN (WAJIB DIIKUTI):
- Sapaan / basa-basi singkat ("hai", "apa kabar", "siapa kamu") -> balas 1 kalimat saja.
- Pertanyaan singkat / butuh jawaban faktual cepat (ya/tidak, definisi singkat, angka) -> 1-3 kalimat, langsung ke jawaban.
- Permintaan penjelasan, tutorial, perbandingan, atau topik teknis -> jawaban detail, terstruktur (gunakan list/numbering bila relevan), TANPA basa-basi pembuka seperti "Tentu, saya akan menjelaskan...". Langsung masuk ke isi.
- Jangan mengulang pertanyaan pengguna sebelum menjawab.
- Jangan menambahkan kalimat penutup generik seperti "Apakah ada yang bisa saya bantu lagi?" kecuali pengguna terlihat baru memulai percakapan.
- Jangan pernah membahas topik di luar yang ditanyakan (misalnya jangan otomatis menjelaskan API kalau tidak diminta).
- Kalau pertanyaan ambigu atau kurang konteks, jangan asal tebak liar — boleh sebutkan asumsi singkat lalu tetap jawab dengan asumsi terbaik.
- Untuk topik teknis/matematis/logika, pikirkan langkah demi langkah secara internal supaya jawaban akurat, tapi tampilkan hasilnya secara ringkas dan rapi (jangan tampilkan "proses berpikir" mentah-mentah kecuali diminta).

ATURAN FORMAT MARKDOWN (WAJIB DIIKUTI):
- Gunakan markdown standar: **tebal** untuk istilah penting, \`kode inline\` untuk nama variabel/fungsi/perintah, dan blok kode \`\`\`bahasa untuk potongan kode multi-baris.
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
- Aturan icon ini hanya berlaku untuk list/poin-poin. Untuk paragraf biasa dan blok kode, tidak perlu pakai icon.

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
						"API menghubungkan dua aplikasi untuk bertukar data lewat 3 langkah:\n\n1️⃣ **Request**: klien mengirim permintaan ke server.\n2️⃣ **Proses**: server mengambil data dari database.\n3️⃣ **Response**: server mengembalikan data ke klien, biasanya format JSON.\n\n💡 Tips: pakai format JSON karena lebih ringan dan mudah diparsing dibanding XML."
				},
				...trimmedHistory,
				{ role: "user", content: cleanMessage }
			];

			// === 4. PANGGIL AI (STREAMING) ===
			// stream: true -> Workers AI balikin ReadableStream berisi SSE
			// (Server-Sent Events). Setiap event berbentuk:
			//   data: {"response":"token berikutnya"}
			// diakhiri dengan:
			//   data: [DONE]
			// max_tokens dinaikkan karena model 70B lebih efisien menyusun
			// jawaban terstruktur tanpa banyak mengulang.
			let aiStream;
			try {
				aiStream = await env.AI.run(model, {
					messages,
					max_tokens: 1024,
					temperature: 0.4,
					stream: true
				});
			} catch (modelError) {
				// Model utama gagal/timeout -> fallback ke model 8B yang lebih ringan
				// supaya user tetap dapat jawaban, bukan error mentah.
				console.error("Model utama gagal, fallback ke 8B:", modelError);
				aiStream = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
					messages,
					max_tokens: 512,
					temperature: 0.4,
					stream: true
				});
			}

			return new Response(aiStream, {
				headers: {
					...corsHeaders,
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					"Connection": "keep-alive"
				}
			});

		} catch (error) {
			console.error("Worker error:", error);
			return new Response(JSON.stringify({ error: error.toString() }), {
				status: 500,
				headers: { ...corsHeaders, "Content-Type": "application/json" }
			});
		}
	}
};

/**
 * Bungkus balasan instan (shortcut sapaan) jadi format SSE yang SAMA PERSIS
 * dengan output streaming Workers AI, supaya frontend bisa pakai satu jalur
 * parsing untuk kedua kasus (tidak perlu cabang if/else di sisi client).
 */
function streamPlainText(text, corsHeaders) {
	const encoder = new TextEncoder();
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`));
			controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
			controller.close();
		}
	});

	return new Response(body, {
		headers: {
			...corsHeaders,
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive"
		}
	});
}

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
		"kamu siapa": "Aku AI Orcaku, asisten virtual yang siap membantu kebutuhanmu.",
		"siapa kamu": "Aku AI Orcaku, asisten virtual yang siap membantu kebutuhanmu.",
		"kamu siapa?": "Aku AI Orcaku, asisten virtual yang siap membantu kebutuhanmu.",
		"makasih": "Sama-sama! Ada lagi yang bisa aku bantu?",
		"terima kasih": "Sama-sama! Ada lagi yang bisa aku bantu?",
		"thanks": "Sama-sama! Ada lagi yang bisa aku bantu?"
	};

	return greetingMap[normalized] || null;
}