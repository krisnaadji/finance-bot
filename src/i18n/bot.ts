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
  invalidCommand: string;
  dependencyUnavailable: string;
  resourceMissing: string;
  conflict: string;
  inactiveAccount: string;
  confirmationUnsupported: string;
  confirmationExpired: string;
  confirmationHandled: string;
  uncategorized: string;
  budgetWarningUnavailable: string;
  batchPartial: string;
  batchOutcomeUnknown: string;
  categoryAdded: (name: string, type: 'income' | 'expense') => string;
};

export const t: Record<Lang, BotStrings> = {
  id: {
    invalidCommand: 'Periksa nominal, jenis, tanggal, dan kategori lalu kirim koreksi.',
    dependencyUnavailable: 'Layanan tidak tersedia. Periksa hasil di dashboard sebelum mengirim ulang.',
    resourceMissing: 'Data tidak ditemukan. Tidak ada perubahan yang dikonfirmasi.',
    conflict: 'Permintaan bertentangan dengan data yang sudah ada.',
    inactiveAccount: 'Akun tidak aktif atau tidak lagi terhubung ke chat ini.',
    confirmationUnsupported: 'Minta hapus lagi lalu balas ya/tidak ke pesan konfirmasi itu dengan pengirim yang sama. Tanpa ID balasan, penghapusan tidak didukung.',
    confirmationExpired: 'Konfirmasi sudah kedaluwarsa. Minta hapus lagi.',
    confirmationHandled: 'Konfirmasi sudah ditangani atau tidak berlaku. Tidak ada penghapusan baru.',
    uncategorized: 'Tanpa kategori',
    budgetWarningUnavailable: 'Peringatan budget tidak dapat diperiksa.',
    batchPartial: 'Penyimpanan sebagian gagal. Hanya transaksi berikut yang masih tercatat; periksa dashboard sebelum mengirim ulang.',
    batchOutcomeUnknown: 'Penyimpanan sebagian gagal dan hasil akhir tidak dapat diperiksa. Periksa dashboard sebelum mengirim ulang.',
    categoryAdded: (name, type) => `Kategori *${name}* ditambahkan sebagai ${type === 'income' ? 'pemasukan' : 'pengeluaran'}.`,
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
      'Balas *ya* atau *tidak* ke pesan ini dari nomor yang meminta penghapusan.\n_(Hangus dalam 60 detik)_',
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
      '*📝 Catat transaksi:*\n' +
      'Cukup ketik transaksi kamu, contoh:\n' +
      '_makan siang 35k_\n' +
      '_gaji masuk 5jt_\n' +
      '_kemarin bayar listrik 150rb_\n\n' +
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
    invalidCommand: 'Check the amount, type, date, and category, then send a correction.',
    dependencyUnavailable: 'Service unavailable. Check the dashboard outcome before resubmitting.',
    resourceMissing: 'Record not found. No change has been confirmed.',
    conflict: 'This request conflicts with existing data.',
    inactiveAccount: 'Account inactive or no longer linked to this chat.',
    confirmationUnsupported: 'Request deletion again, then reply yes/no to that confirmation from the same sender. Deletion is unsupported without a reply ID.',
    confirmationExpired: 'Confirmation expired. Request deletion again.',
    confirmationHandled: 'Confirmation already handled or no longer valid. No new deletion occurred.',
    uncategorized: 'Uncategorized',
    budgetWarningUnavailable: 'Budget warnings could not be checked.',
    batchPartial: 'Some saves failed. Only the transactions below remain recorded; check the dashboard before resubmitting.',
    batchOutcomeUnknown: 'Some saves failed and the final outcome could not be checked. Check the dashboard before resubmitting.',
    categoryAdded: (name, type) => `Category *${name}* added as ${type}.`,
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
      'Reply *yes* or *no* to this message from the sender who requested deletion.\n_(Expires in 60 seconds)_',
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
      '*📝 Record transactions:*\n' +
      'Just type your transaction, e.g.:\n' +
      '_lunch 35k_\n' +
      '_received salary 5jt_\n' +
      '_paid electricity bill 150rb yesterday_\n\n' +
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
