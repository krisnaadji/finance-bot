import { Lang } from '../utils/lang';

type BotStrings = {
  txnCreated: (
    desc: string,
    amount: string,
    cat: string,
    date: string,
    type: string,
  ) => string;
  txnEdited: string;
  txnDeleted: string;
  txnDeleteCancel: string;
  deleteConfirm: (
    desc: string,
    amount: string,
    cat: string,
    date: string,
  ) => string;
  notSetup: (url: string) => string;
  setupOk: (name: string) => string;
  setupBadCode: (url: string) => string;
  langChanged: (lang: string) => string;
  helpText: string;
};

export const t: Record<Lang, BotStrings> = {
  id: {
    txnCreated: (desc, amount, cat, date, type) =>
      (type === 'income' ? '💰' : '💸') +
      ' *Tercatat!*\n' +
      desc +
      '\n' +
      (type === 'income' ? '+' : '-') +
      'Rp' +
      amount +
      ' · ' +
      cat +
      '\n' +
      '📅 ' +
      date +
      '\n\n_Balas pesan ini untuk edit atau hapus_',
    txnEdited: '✅ Transaksi berhasil diperbarui!',
    txnDeleted: '🗑️ Transaksi berhasil dihapus.',
    txnDeleteCancel: '❌ Penghapusan dibatalkan.',
    deleteConfirm: (desc, amount, cat, date) =>
      '⚠️ *Yakin ingin menghapus transaksi ini?*\n' +
      desc +
      ' · Rp' +
      amount +
      ' · ' +
      cat +
      '\n📅 ' +
      date +
      '\n\n' +
      'Balas *ya* untuk hapus, *tidak* untuk batal.\n_(Hangus dalam 60 detik)_',
    notSetup: (url: string) =>
      'Halo! Bot belum dikonfigurasi untuk chat ini.\n' +
      'Buka dashboard untuk membuat akun dan dapatkan kode setup:\n' +
      '*' +
      url +
      '*\n\n' +
      'Setelah dapat kode, kirim:\n*/setup KODE*',
    setupOk: (name) =>
      '✅ *Akun berhasil dihubungkan!*\nNama: *' +
      name +
      '*\n\nContoh:\n_makan siang 35k_\n_gaji masuk 5jt_',
    setupBadCode: (url: string) =>
      '❌ Kode tidak valid atau sudah kadaluarsa.\n' +
      'Buat kode baru di dashboard:\n*' +
      url +
      '*',
    langChanged: (lang) =>
      '✅ Bahasa diubah ke ' +
      (lang === 'id' ? 'Bahasa Indonesia' : 'English') +
      '.',
    helpText:
      '📖 *Perintah Finance Bot*\n\n' +
      '1. Ringkasan bulan ini\n' +
      '   /rekap\n\n' +
      '2. Ringkasan sejak gaji terakhir\n' +
      '   /rekap gaji\n\n' +
      '3. Daftar kategori\n' +
      '   /kategori\n\n' +
      '4. Cari transaksi\n' +
      '   /cari KATA\n\n' +
      '5. Dashboard\n' +
      '   /dashboard\n\n' +
      '6. Ganti bahasa\n' +
      '   /language id|en\n\n' +
      '7. Hubungkan akun\n' +
      '   /setup KODE\n\n' +
      'Kamu juga bisa menjalankan perintah dengan membalas angka di atas.\n' +
      'Contoh: balas 2 untuk ringkasan sejak gaji terakhir.',
  },
  en: {
    txnCreated: (desc, amount, cat, date, type) =>
      (type === 'income' ? '💰' : '💸') +
      ' *Recorded!*\n' +
      desc +
      '\n' +
      (type === 'income' ? '+' : '-') +
      'Rp' +
      amount +
      ' · ' +
      cat +
      '\n' +
      '📅 ' +
      date +
      '\n\n_Reply to this message to edit or delete_',
    txnEdited: '✅ Transaction updated successfully!',
    txnDeleted: '🗑️ Transaction deleted.',
    txnDeleteCancel: '❌ Deletion cancelled.',
    deleteConfirm: (desc, amount, cat, date) =>
      '⚠️ *Delete this transaction?*\n' +
      desc +
      ' · Rp' +
      amount +
      ' · ' +
      cat +
      '\n📅 ' +
      date +
      '\n\n' +
      'Reply *yes* to confirm, *no* to cancel.\n_(Expires in 60 seconds)_',
    notSetup: (url: string) =>
      'Hi! This bot is not configured for this chat.\n' +
      'Open the dashboard to create an account and get a setup code:\n' +
      '*' +
      url +
      '*\n\n' +
      'Then send:\n*/setup CODE*',
    setupOk: (name) =>
      '✅ *Account linked!*\nName: *' +
      name +
      '*\n\nExamples:\n_lunch 35k_\n_received salary 5jt_',
    setupBadCode: (url: string) =>
      '❌ Invalid or expired code.\n' +
      'Generate a new one from the dashboard:\n*' +
      url +
      '*',
    langChanged: (lang) =>
      '✅ Language changed to ' +
      (lang === 'en' ? 'English' : 'Bahasa Indonesia') +
      '.',
    helpText:
      '📖 *Finance Bot Commands*\n\n' +
      '1. This month summary\n' +
      '   /summary\n\n' +
      '2. Summary since latest salary\n' +
      '   /summary salary\n\n' +
      '3. Categories\n' +
      '   /categories\n\n' +
      '4. Search transactions\n' +
      '   /search KEYWORD\n\n' +
      '5. Dashboard\n' +
      '   /dashboard\n\n' +
      '6. Change language\n' +
      '   /language id|en\n\n' +
      '7. Link account\n' +
      '   /setup CODE\n\n' +
      'You can also run a command by replying with the number above.\n' +
      'Example: reply 2 for the latest salary-cycle summary.',
  },
};
