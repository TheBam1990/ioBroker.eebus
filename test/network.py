"""Exercise real TLS/WebSocket/SHIP/SPINE traffic against a reference Energy Guard."""
import json,os,queue,subprocess,tempfile,threading,time
from pathlib import Path
root=Path(__file__).resolve().parent.parent
messages=queue.Queue();procs=[];history=[]
def start(name,args):
 p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1);procs.append(p)
 def read():
  for line in p.stdout:
   try:messages.put((name,json.loads(line)))
   except json.JSONDecodeError: print(name,'NONJSON',line.strip(),flush=True)
 threading.Thread(target=read,daemon=True).start();return p
def wait(name,event,check=lambda d:True,timeout=30):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  try:n,m=messages.get(timeout=1)
  except queue.Empty:continue
  history.append((n,m))
  if m['event'] in ('error','fatal'):print(n,m,flush=True)
  if n==name and m['event']==event and check(m['data']):return m['data']
 raise AssertionError(f'Timed out: {name} {event}; tail={history[-8:]}')
def send(p,obj):p.stdin.write(json.dumps(obj)+'\n');p.stdin.flush()
try:
 folder=Path(tempfile.mkdtemp(prefix='eebus-network-'))
 cfg=dict(port=54712,brand='ioBroker',model='EEBUS Network Test',serial=folder.name,dataDir=str(folder),generate=True,nominalConsumptionW=11000,nominalProductionW=10000,simulation=True,powerW=6000)
 (folder/'config.json').write_text(json.dumps(cfg))
 bridge=start('bridge',[str(root/'bin/eebus-bridge-linux-amd64'),'-config',str(folder/'config.json')]);ready=wait('bridge','ready');print('IDENTITY',ready['ski'],flush=True)
 peer=start('peer',['/tmp/eebus-test-peer','-port','54713','-ski',ready['ski']]);remote=wait('peer','ready')
 send(bridge,dict(id='open',op='pairing',value=1));send(bridge,dict(id='trust',op='trust',ski=remote['ski']))
 wait('bridge','connected',lambda d:d['connected'],timeout=35);print('SHIP_CONNECTED',flush=True)
 wait('peer','useCaseEvent',lambda d:d['event']=='eg-lpc-UseCaseSupportUpdate',timeout=30)
 time.sleep(3)
 send(peer,dict(Op='lpc',Value=2500,Duration=12))
 wait('bridge','limit',lambda d:d['useCase']=='lpc' and d['limit']['Value']==2500)
 wait('peer','power',lambda d:d==2500);print('LPC_AND_MPC_OK',flush=True)
 send(bridge,dict(id='production',op='power',value=-7000))
 send(peer,dict(Op='lpp',Value=-3000,Duration=12))
 wait('bridge','limit',lambda d:d['useCase']=='lpp' and d['limit']['Value']==-3000)
 wait('peer','power',lambda d:d==-3000);print('LPP_AND_MPC_OK',flush=True)
 send(peer,dict(Op='lpc',Value=20000,Duration=12))
 result=wait('peer','writeResult',lambda d:d.get('errorNumber',d.get('ErrorNumber',0)) not in (0,None))
 print('INVALID_LIMIT_REJECTED',result,flush=True)
 assert (folder/'trusted.json').exists()
 bridge.terminate();bridge.wait(timeout=7)
 bridge=start('bridge2',[str(root/'bin/eebus-bridge-linux-amd64'),'-config',str(folder/'config.json')]);ready2=wait('bridge2','ready')
 assert ready2['ski']==ready['ski'];print('PERSISTENT_SKI_OK',flush=True)
 wait('bridge2','connected',lambda d:d['connected'],timeout=35);print('PERSISTENT_TRUST_RECONNECT_OK',flush=True)
 print('NETWORK_TEST_PASS',flush=True)
finally:
 for p in procs:
  if p.poll() is None:p.terminate()
 for p in procs:
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill()
 (root/'test/network-last.json').write_text(json.dumps(history,indent=2))
