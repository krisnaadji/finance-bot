begin;
set local lock_timeout='5s';
do $$ begin
 if pg_catalog.to_regprocedure('public.start_finance_export(uuid,jsonb)') is null or
    not exists(select 1 from information_schema.columns where table_schema='public' and table_name='finance_export_rows' and column_name='subcategory') then
  raise exception 'Category catalog activation prerequisites missing'; end if;
end $$;
create function bot_private.category_catalog() returns table(code text,parent_code text,type text,name_id text,name_en text,sort_order integer)
language sql immutable set search_path='' as $$ values
 ('expense.basic_needs',null,'expense','Kebutuhan Pokok','Basic Needs',100),
 ('expense.food',null,'expense','Makanan & Minuman','Food & Drinks',200),
 ('expense.food.groceries','expense.food','expense','Bahan Makanan','Groceries',201),
 ('expense.food.dining_out','expense.food','expense','Makan di Luar','Dining Out',202),
 ('expense.food.delivery','expense.food','expense','Pesan Antar Makanan','Food Delivery',203),
 ('expense.food.snacks_coffee','expense.food','expense','Camilan & Kopi','Snacks & Coffee',204),
 ('expense.household',null,'expense','Rumah Tangga','Household',300),
 ('expense.household.cleaning','expense.household','expense','Perlengkapan Kebersihan','Cleaning Supplies',301),
 ('expense.household.toiletries','expense.household','expense','Perlengkapan Mandi','Toiletries',302),
 ('expense.household.laundry','expense.household','expense','Penatu','Laundry',303),
 ('expense.housing',null,'expense','Rumah & Tagihan','Housing & Bills',400),
 ('expense.housing.rent','expense.housing','expense','Sewa Rumah','Rent',401),
 ('expense.housing.electricity','expense.housing','expense','Listrik','Electricity',402),
 ('expense.housing.water','expense.housing','expense','Air','Water',403),
 ('expense.housing.internet','expense.housing','expense','Internet','Internet',404),
 ('expense.housing.phone_data','expense.housing','expense','Telepon & Paket Data','Phone & Data',405),
 ('expense.housing.maintenance','expense.housing','expense','Perawatan Rumah','Home Maintenance',406),
 ('expense.transport',null,'expense','Transportasi','Transport',500),
 ('expense.transport.public','expense.transport','expense','Transportasi Umum','Public Transport',501),
 ('expense.transport.ride_hailing','expense.transport','expense','Ojek & Taksi Online','Ride-Hailing',502),
 ('expense.transport.fuel','expense.transport','expense','Bahan Bakar','Fuel',503),
 ('expense.transport.parking_tolls','expense.transport','expense','Parkir & Tol','Parking & Tolls',504),
 ('expense.transport.maintenance','expense.transport','expense','Perawatan Kendaraan','Vehicle Maintenance',505),
 ('expense.health',null,'expense','Kesehatan','Health',600),
 ('expense.health.doctor_hospital','expense.health','expense','Dokter & Rumah Sakit','Doctor & Hospital',601),
 ('expense.health.medicine','expense.health','expense','Obat','Medicine',602),
 ('expense.health.dental','expense.health','expense','Perawatan Gigi','Dental Care',603),
 ('expense.health.insurance','expense.health','expense','Asuransi Kesehatan','Health Insurance',604),
 ('expense.work',null,'expense','Pekerjaan & Usaha','Work & Business',700),
 ('expense.work.equipment','expense.work','expense','Peralatan Kerja','Work Equipment',701),
 ('expense.work.software','expense.work','expense','Perangkat Lunak','Software',702),
 ('expense.work.office_supplies','expense.work','expense','Alat Tulis Kantor','Office Supplies',703),
 ('expense.work.operations','expense.work','expense','Operasional Usaha','Business Operations',704),
 ('expense.debt',null,'expense','Cicilan & Utang','Installments & Debt',800),
 ('expense.debt.mortgage','expense.debt','expense','KPR','Mortgage',801),
 ('expense.debt.vehicle','expense.debt','expense','Cicilan Kendaraan','Vehicle Loan',802),
 ('expense.debt.credit_card','expense.debt','expense','Kartu Kredit','Credit Card',803),
 ('expense.debt.personal','expense.debt','expense','Pinjaman Pribadi','Personal Loan',804),
 ('expense.entertainment',null,'expense','Hiburan & Rekreasi','Entertainment & Recreation',900),
 ('expense.entertainment.streaming','expense.entertainment','expense','Layanan Streaming','Streaming',901),
 ('expense.entertainment.games','expense.entertainment','expense','Gim','Games',902),
 ('expense.entertainment.outings','expense.entertainment','expense','Jalan-Jalan','Outings',903),
 ('expense.entertainment.hobbies','expense.entertainment','expense','Hobi','Hobbies',904),
 ('expense.entertainment.holidays','expense.entertainment','expense','Liburan','Holidays',905),
 ('expense.shopping',null,'expense','Belanja Pribadi','Personal Shopping',1000),
 ('expense.shopping.clothing','expense.shopping','expense','Pakaian','Clothing',1001),
 ('expense.shopping.accessories','expense.shopping','expense','Aksesori','Accessories',1002),
 ('expense.shopping.electronics','expense.shopping','expense','Elektronik','Electronics',1003),
 ('expense.shopping.personal_care','expense.shopping','expense','Perawatan Diri','Personal Care',1004),
 ('expense.donations',null,'expense','Donasi & Bantuan','Donations & Support',1100),
 ('expense.donations.donations','expense.donations','expense','Donasi','Donations',1101),
 ('expense.donations.zakat','expense.donations','expense','Zakat','Zakat',1102),
 ('expense.donations.family','expense.donations','expense','Bantuan Keluarga','Family Support',1103),
 ('expense.donations.gifts','expense.donations','expense','Hadiah','Gifts',1104),
 ('expense.education',null,'expense','Pendidikan','Education',1200),
 ('expense.education.tuition','expense.education','expense','Sekolah & Kuliah','School & Tuition',1201),
 ('expense.education.courses','expense.education','expense','Kursus','Courses',1202),
 ('expense.education.books','expense.education','expense','Buku','Books',1203),
 ('expense.education.supplies','expense.education','expense','Perlengkapan Sekolah','School Supplies',1204),
 ('expense.savings',null,'expense','Tabungan','Savings',1300),
 ('expense.savings.emergency','expense.savings','expense','Dana Darurat','Emergency Fund',1301),
 ('expense.savings.purchases','expense.savings','expense','Rencana Pembelian','Planned Purchases',1302),
 ('expense.savings.other','expense.savings','expense','Tujuan Tabungan Lain','Other Savings Goals',1303),
 ('expense.investments',null,'expense','Investasi','Investments',1400),
 ('expense.investments.stocks','expense.investments','expense','Saham','Stocks',1401),
 ('expense.investments.funds','expense.investments','expense','Reksa Dana','Mutual Funds',1402),
 ('expense.investments.gold','expense.investments','expense','Emas','Gold',1403),
 ('expense.investments.other','expense.investments','expense','Investasi Lain','Other Investments',1404),
 ('expense.top_up',null,'expense','Top Up','Top Up',1500),
 ('expense.other',null,'expense','Pengeluaran Lainnya','Other Expenses',1600),
 ('salary',null,'income','Gaji','Salary',1700),
 ('income.bonus',null,'income','Bonus','Bonus',1800),
 ('income.sales',null,'income','Penjualan & Jasa','Sales & Services',1900),
 ('income.sales.products','income.sales','income','Penjualan Produk','Product Sales',1901),
 ('income.sales.services','income.sales','income','Jasa & Freelance','Services & Freelance',1902),
 ('income.sales.personal','income.sales','income','Penjualan Barang Pribadi','Personal-Item Sales',1903),
 ('income.profit_sharing',null,'income','Bagi Hasil','Profit Sharing',2000),
 ('income.profit_sharing.business','income.profit_sharing','income','Bagi Hasil Usaha','Business Distributions',2001),
 ('income.profit_sharing.partnership','income.profit_sharing','income','Bagi Hasil Kemitraan','Partnership Distributions',2002),
 ('income.investments',null,'income','Hasil Investasi','Investment Income',2100),
 ('income.investments.interest','income.investments','income','Bunga','Interest',2101),
 ('income.investments.dividends','income.investments','income','Dividen','Dividends',2102),
 ('income.investments.gains','income.investments','income','Keuntungan Investasi','Investment Gains',2103),
 ('income.top_up',null,'income','Top Up','Top Up',2200),
 ('income.other',null,'income','Pemasukan Lainnya','Other Income',2300),
 ('income.other.gifts','income.other','income','Hadiah','Gifts',2301),
 ('income.other.reimbursements','income.other','income','Penggantian Biaya','Reimbursements',2302),
 ('income.other.refunds','income.other','income','Pengembalian Dana','Refunds',2303),
 ('income.other.other','income.other','income','Pemasukan Lain','Other Earnings',2304)
$$;
create or replace function public.seed_categories(p_account_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare entry record; v_parent uuid; v_parent_active boolean; existing public.categories%rowtype;
begin
 perform 1 from public.accounts where id=p_account_id for update;
 if not found then raise exception 'Unknown account' using errcode='23503'; end if;
 for entry in select * from bot_private.category_catalog() order by (parent_code is not null),sort_order loop
  v_parent=null;v_parent_active=true;
  if entry.parent_code is not null then
   select id,is_active into v_parent,v_parent_active from public.categories where account_id=p_account_id and code=entry.parent_code;
   if not found then raise exception 'Missing catalog root %',entry.parent_code; end if;
  end if;
  select * into existing from public.categories where account_id=p_account_id and code=entry.code;
  if found then
   if existing.type<>entry.type or existing.parent_id is distinct from v_parent or existing.is_custom then
    raise exception 'Catalog identity mismatch for account %, code %',p_account_id,entry.code; end if;
  else
   -- A conflicting custom/default sibling is a migration blocker, never a reason to steal or relabel its UUID.
   insert into public.categories(account_id,code,name_id,name_en,parent_id,type,is_custom,is_active,sort_order)
   values(p_account_id,entry.code,entry.name_id,entry.name_en,v_parent,entry.type,false,v_parent_active,entry.sort_order);
  end if;
 end loop;
end $$;
revoke all on function bot_private.category_catalog() from public,anon,authenticated;
grant execute on function bot_private.category_catalog() to service_role;
do $$ declare account record; begin
 for account in select id from public.accounts order by id loop perform public.seed_categories(account.id); end loop;
end $$;
commit;
