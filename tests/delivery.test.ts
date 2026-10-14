import { afterEach, expect, it, vi } from 'vitest';
import { sendWA } from '../src/services/whatsapp';
import { renderReply } from '../src/delivery/render';
import type { ReplySnapshot } from '../src/delivery/types';
const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
afterEach(()=>{fetchMock.mockReset();vi.unstubAllEnvs();});
function response(status:number,body:string):Response{return new Response(body,{status});}
it('holds a dispatched timeout rather than blindly resending',async()=>{
  fetchMock.mockRejectedValueOnce(new DOMException('timeout','AbortError'));
  expect(await sendWA('fixture-destination','fixture-receipt','meta')).toEqual({kind:'uncertain',code:'transport_unknown'});
});
it('accepts only nonempty provider message IDs',async()=>{
  fetchMock.mockResolvedValueOnce(response(200,'{"messages":[{}]}'));
  expect(await sendWA('fixture-destination','fixture-receipt','meta')).toEqual({kind:'uncertain',code:'missing_provider_id'});
});
it('classifies only documented Meta throughput as retryable and holds unknown 5xx',async()=>{
  fetchMock.mockResolvedValueOnce(response(400,'{"error":{"code":130429}}'));
  expect(await sendWA('fixture-destination','fixture-receipt','meta')).toMatchObject({kind:'rejected',retryable:true,code:'meta_throughput'});
  fetchMock.mockResolvedValueOnce(response(500,'{"error":{"code":99999}}'));
  expect(await sendWA('fixture-destination','fixture-receipt','meta')).toEqual({kind:'uncertain',code:'provider_server_unknown'});
});
it('classifies known Fonnte rejection and treats malformed success as uncertain',async()=>{
  vi.stubEnv('FONNTE_TOKEN','synthetic-token');
  fetchMock.mockResolvedValueOnce(response(200,'{"status":false,"reason":"insufficient quota"}'));
  expect(await sendWA('fixture-destination','fixture-receipt','fonnte')).toMatchObject({kind:'rejected',retryable:true,code:'provider_quota'});
  fetchMock.mockResolvedValueOnce(response(200,'not-json'));
  expect(await sendWA('fixture-destination','fixture-receipt','fonnte')).toEqual({kind:'uncertain',code:'malformed_provider_response'});
});
it('uses bounded documented retry-after and explicit permanent rejections',async()=>{
 fetchMock.mockResolvedValueOnce(new Response('{"error":{"code":130429}}',{status:400,headers:{'retry-after':'45'}}));
 expect(await sendWA('fixture-destination','fixture-receipt','meta')).toMatchObject({kind:'rejected',retryable:true,retryAfterSeconds:45});
 fetchMock.mockResolvedValueOnce(response(400,'{"error":{"code":131026}}'));
 expect(await sendWA('fixture-destination','fixture-receipt','meta')).toMatchObject({kind:'rejected',retryable:false,code:'meta_rejected'});
 vi.stubEnv('FONNTE_TOKEN','synthetic-token');
 fetchMock.mockResolvedValueOnce(response(200,'{"status":false,"reason":"target invalid"}'));
 expect(await sendWA('fixture-destination','fixture-receipt','fonnte')).toMatchObject({kind:'rejected',retryable:false,code:'provider_invalid_request'});
});
it('renders receipt only from the committed immutable amount and description',()=>{
  const snapshot:ReplySnapshot={language:'en',kind:'receipt',code:'created',text:null,categoryName:null,categoryType:null,accountName:null,
    rows:[{index:1,id:'00000000-0000-4000-8000-000000000001',amount:'30.00',type:'expense',description:'original meal',date:'2026-10-13',categoryName:'Food'}]};
  const text=renderReply(snapshot);
  expect(text).toContain('original meal');expect(text).toContain('Rp30');expect(text).not.toContain('later edit');
});
