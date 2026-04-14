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
      '📖 *Panduan Bot Keuangan:*\n\n' +
      '*📝 Catat transaksi:*\n' +
      'Cukup ketik transaksi kamu, contoh:\n' +
      '_makan siang 35k_\n' +
      '_gaji masuk 5jt_\n' +
      '_kemarin bayar listrik 150rb_\n\n' +
      '*✏️ Edit & hapus:*\n' +
      'Balas pesan konfirmasi bot untuk edit atau hapus.\n\n' +
      '*📊 Perintah:*\n' +
      '/rekap — ringkasan bulan ini\n' +
      '/kategori — lihat semua kategori\n' +
      '/dashboard — buka dashboard web\n' +
      '/language id|en — ganti bahasa\n' +
      '/setup KODE — hubungkan akun baru\n' +
      '/help — tampilkan bantuan ini',
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
      '📖 *Finance Bot Guide:*\n\n' +
      '*📝 Record transactions:*\n' +
      'Just type your transaction, e.g.:\n' +
      '_lunch 35k_\n' +
      '_received salary 5jt_\n' +
      '_paid electricity bill 150rb yesterday_\n\n' +
      '*✏️ Edit & delete:*\n' +
      'Reply to any bot confirmation message to edit or delete.\n\n' +
      '*📊 Commands:*\n' +
      '/rekap — this month summary\n' +
      '/kategori — list categories\n' +
      '/dashboard — open web dashboard\n' +
      '/language id|en — change language\n' +
      '/setup CODE — link a new account\n' +
      '/help — show this help',
  },
};
