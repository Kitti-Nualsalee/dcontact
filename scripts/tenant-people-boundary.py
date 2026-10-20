import concurrent.futures
import hashlib
import json
import os
import pathlib
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import tempfile

KEYCLOAK_IMAGE='docker.io/keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85'

def run_boundary(root,work,postgres,network,container,postgres_port):
    image=KEYCLOAK_IMAGE
    details=json.loads(subprocess.check_output(['docker','inspect',postgres],text=True))[0]
    if network not in details['NetworkSettings']['Networks']:
        raise SystemExit('SANDBOX_NETWORK_MISMATCH')
    settings=dict(value.split('=',1) for value in details['Config']['Env'] if '=' in value)
    owner=settings.get('POSTGRES_USER','postgres')
    database='v709_keycloak_'+uuid.uuid4().hex[:12]
    def sql(statement):
        return subprocess.check_output(['docker','exec','-i',postgres,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U',owner,'-d',database],input=statement,text=True)
    subprocess.run(['docker','exec','-i',postgres,'psql','-X','-v','ON_ERROR_STOP=1','-U',owner,'-d','postgres'],input='CREATE DATABASE '+database+';',text=True,check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['docker','run','--rm','--network','none','--user',str(os.getuid())+':'+str(os.getgid()),'-v',str(root/'infra/keycloak/extensions/tenant-people/src/main')+':/src:ro','-v',str(work)+':/work','eclipse-temurin:21-jdk','sh','-ec','javac --release 21 -proc:none -cp "/work/lib/*" -d /work/classes $(find /src/java -name "*.java"); cp -r /src/resources/. /work/classes/; cd /work/classes; jar cf /work/dcontact-tenant-people.jar .'],check=True)
    os.chmod(work/'dcontact-tenant-people.jar',0o644)
    environment=os.environ.copy()
    environment.update(KC_DB_PASSWORD=settings['POSTGRES_PASSWORD'],KC_BOOTSTRAP_ADMIN_PASSWORD=uuid.uuid4().hex)
    base=None
    started=False
    def call(path,token=None,body=None,method=None,form=None):
        headers={}
        if token:headers['Authorization']='Bearer '+token
        data=None
        if body is not None:
            data=json.dumps(body).encode();headers['Content-Type']='application/json'
        if form is not None:
            data=urllib.parse.urlencode(form).encode();headers['Content-Type']='application/x-www-form-urlencoded'
        request=urllib.request.Request(base+path,data=data,headers=headers,method=method or ('POST' if data is not None else 'GET'))
        try:
            with urllib.request.urlopen(request,timeout=40) as response:
                content=response.read();return response.status,json.loads(content) if content else None,dict(response.headers)
        except urllib.error.HTTPError as failure:
            content=failure.read()
            try:value=json.loads(content)
            except Exception:value={'code':'NON_JSON_RESPONSE'}
            return failure.code,value,dict(failure.headers)
    def expect(path,token=None,body=None,method=None,status=201):
        actual,result,headers=call(path,token,body,method)
        if actual!=status:raise RuntimeError('HTTP_BOUNDARY_STATUS_'+str(actual)+'_EXPECTED_'+str(status)+'_'+str(result.get('code','UNKNOWN') if isinstance(result,dict) else 'UNKNOWN'))
        return result,headers
    try:
        args=['docker','run','-d','--pull=never','--name',container,'--network',network,'--memory','1g','--cpus','2','--security-opt','no-new-privileges','--cap-drop','ALL','-p','127.0.0.1::8080',
            '-v',str(work/'dcontact-tenant-people.jar')+':/opt/keycloak/providers/dcontact-tenant-people.jar:ro',
            '-e','KC_DB=postgres','-e','KC_DB_URL=jdbc:postgresql://'+postgres+':5432/'+database,'-e','KC_DB_USERNAME='+owner,'-e','KC_DB_PASSWORD','-e','KC_BOOTSTRAP_ADMIN_USERNAME=b2-boundary-admin','-e','KC_BOOTSTRAP_ADMIN_PASSWORD',image,'start-dev','--http-port=8080']
        subprocess.run(args,env=environment,check=True,stdout=subprocess.DEVNULL);started=True
        published=json.loads(subprocess.check_output(['docker','inspect',container],text=True))[0]['NetworkSettings']['Ports']['8080/tcp'][0]
        base='http://127.0.0.1:'+published['HostPort']
        deadline=time.monotonic()+180
        while time.monotonic()<deadline:
            try:
                if call('/realms/master/.well-known/openid-configuration')[0]==200:break
            except Exception:pass
            time.sleep(1)
        else:raise RuntimeError('KEYCLOAK_STARTUP_TIMEOUT')
        status,login,_=call('/realms/master/protocol/openid-connect/token',form={'grant_type':'password','client_id':'admin-cli','username':'b2-boundary-admin','password':environment['KC_BOOTSTRAP_ADMIN_PASSWORD']})
        if status!=200:raise RuntimeError('SANDBOX_ADMIN_LOGIN_FAILED')
        admin=login['access_token'];realm='b2-'+uuid.uuid4().hex[:12];adminbase='/admin/realms/'+realm
        expect('/admin/realms',admin,{'realm':realm,'enabled':True,'organizationsEnabled':True,'sslRequired':'none'})
        for role in ('agent','supervisor','admin'):expect(adminbase+'/roles',admin,{'name':role})
        profile,_=expect(adminbase+'/users/profile',admin,status=200)
        for name in ('dc_identity_class','tenant_id','tenant_slug','dc_user_id','dc_tenant_people_operation_id'):
            profile['attributes'].append({'name':name,'multivalued':False,'permissions':{'view':['admin'],'edit':['admin']}})
        expect(adminbase+'/users/profile',admin,profile,method='PUT',status=200)
        tenants=[]
        for index in range(2):
            tenant=str(uuid.uuid4());slug='tenant-'+str(index)+'-'+uuid.uuid4().hex[:8]
            _,headers=expect(adminbase+'/organizations',admin,{'name':slug,'alias':slug,'enabled':True,'attributes':{'tenant_id':[tenant]}})
            organization=headers['Location'].rsplit('/',1)[-1]
            clientid='dcontact-tenant-people-'+tenant
            expect(adminbase+'/clients',admin,{'clientId':clientid,'enabled':True,'publicClient':False,'serviceAccountsEnabled':True,'fullScopeAllowed':False,
                'attributes':{'dc_service_purpose':'TENANT_PEOPLE_V1','tenant_id':tenant,'tenant_slug':slug,'dc_organization_id':organization,'dc_allowed_roles':'AGENT,SUPERVISOR,ADMIN'},
                'protocolMappers':[{'name':'people-audience','protocol':'openid-connect','protocolMapper':'oidc-audience-mapper','config':{'included.custom.audience':'dc-tenant-people','access.token.claim':'true','id.token.claim':'false'}}]})
            clients,_=expect(adminbase+'/clients?clientId='+clientid,admin,status=200)
            secret,_=expect(adminbase+'/clients/'+clients[0]['id']+'/client-secret',admin,status=200)
            status,token,_=call('/realms/'+realm+'/protocol/openid-connect/token',form={'grant_type':'client_credentials','client_id':clientid,'client_secret':secret['value']})
            if status!=200:raise RuntimeError('SANDBOX_SERVICE_LOGIN_FAILED')
            tenants.append({'id':tenant,'slug':slug,'token':token['access_token'],'client':clients[0]['id'],'organization':organization,'clientId':clientid,'secret':secret['value']})
        ready_path='/realms/'+realm+'/dc-tenant-people/readiness?tenantId='+tenants[0]['id']
        expect(ready_path,tenants[0]['token'],status=200)
        expect(ready_path,tenants[1]['token'],status=403)
        client_configuration,_=expect(adminbase+'/clients/'+tenants[0]['client'],admin,status=200)
        partial_roles={**client_configuration,'attributes':{**client_configuration['attributes'],'dc_allowed_roles':'AGENT'}}
        expect(adminbase+'/clients/'+tenants[0]['client'],admin,partial_roles,method='PUT',status=204)
        expect(ready_path,tenants[0]['token'],status=503)
        expect(adminbase+'/clients/'+tenants[0]['client'],admin,client_configuration,method='PUT',status=204)
        organization_configuration,_=expect(adminbase+'/organizations/'+tenants[0]['organization'],admin,status=200)
        expect(adminbase+'/organizations/'+tenants[0]['organization'],admin,{**organization_configuration,'enabled':False},method='PUT',status=204)
        expect(ready_path,tenants[0]['token'],status=403)
        expect(adminbase+'/organizations/'+tenants[0]['organization'],admin,organization_configuration,method='PUT',status=204)
        missing_classification={**profile,'attributes':[attribute for attribute in profile['attributes'] if attribute['name']!='dc_identity_class']}
        expect(adminbase+'/users/profile',admin,missing_classification,method='PUT',status=200)
        expect(ready_path,tenants[0]['token'],status=503)
        expect(adminbase+'/users/profile',admin,profile,method='PUT',status=200)
        expect(ready_path,tenants[0]['token'],status=200)
        def envelope():return {'tenantId':tenants[0]['id'],'targetUserId':str(uuid.uuid4()),'payloadDigest':hashlib.sha256(uuid.uuid4().bytes).hexdigest(),'fencingToken':'1','email':uuid.uuid4().hex+'@example.test','displayName':'ทดสอบ B2','role':'AGENT'}
        body=envelope();operation=str(uuid.uuid4());path='/realms/'+realm+'/dc-tenant-people/operations/'+operation+'/steps/CREATE_IDENTITY'
        expect(path,None,body,status=401)
        expect(path,tenants[1]['token'],body,status=403)
        expect(path,tenants[0]['token'],{**body,'attributes':{}},status=400)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:call(path,tenants[0]['token'],body),range(2)))
        if [value[0] for value in results]!=[200,200]:raise RuntimeError('CONCURRENT_CREATE_FAILED_'+str([value[0] for value in results]))
        if results[0][1]!=results[1][1] or results[0][1]['outcome']!='SUCCEEDED':raise RuntimeError('RECEIPT_REPLAY_MISMATCH')
        created,_=expect(adminbase+'/users/'+body['targetUserId'],admin,status=200)
        if created.get('emailVerified') or created['attributes']['dc_identity_class']!=['TENANT_USER']:raise RuntimeError('CREATED_CLASSIFICATION_INVALID')
        if set(created['requiredActions'])!={'VERIFY_EMAIL','UPDATE_PASSWORD','CONFIGURE_TOTP'}:raise RuntimeError('REQUIRED_ACTIONS_INVALID')
        credentials,_=expect(adminbase+'/users/'+body['targetUserId']+'/credentials',admin,status=200)
        if credentials:raise RuntimeError('UNEXPECTED_CREDENTIAL')
        expect(path,tenants[0]['token'],{**body,'role':'ADMIN'},status=409)
        expect(path,tenants[0]['token'],{**body,'fencingToken':'2'},status=200)
        expect(path,tenants[0]['token'],body,status=409)
        query=urllib.parse.urlencode({key:body[key] for key in ('tenantId','targetUserId','payloadDigest')})
        replay,_=expect(path+'?'+query,tenants[0]['token'],status=200)
        if replay['receiptRef']!=results[0][1]['receiptRef']:raise RuntimeError('READBACK_RECEIPT_MISMATCH')
        foreign={**envelope(),'tenantId':tenants[1]['id'],'targetUserId':body['targetUserId']}
        rejected,_=expect('/realms/'+realm+'/dc-tenant-people/operations/'+str(uuid.uuid4())+'/steps/CREATE_IDENTITY',tenants[1]['token'],foreign,status=200)
        if rejected['outcome']!='REJECTED_NO_EFFECT':raise RuntimeError('FOREIGN_TARGET_ADOPTED')
        after,_=expect(adminbase+'/users/'+body['targetUserId'],admin,status=200)
        if after!=created:raise RuntimeError('FOREIGN_SIDE_EFFECT')
        protected_email='protected-'+uuid.uuid4().hex+'@example.test'
        _,protected_headers=expect(adminbase+'/users',admin,{'username':protected_email,'email':protected_email,'enabled':True,'attributes':{'dc_identity_class':['PLATFORM_USER']}})
        protected_id=protected_headers['Location'].rsplit('/',1)[-1]
        protected_membership,_,_=call(adminbase+'/organizations/'+tenants[0]['organization']+'/members',admin,protected_id)
        if protected_membership not in (201,204):raise RuntimeError('PROTECTED_FIXTURE_MEMBERSHIP_FAILED')
        protected_before,_=expect(adminbase+'/users/'+protected_id,admin,status=200)
        protected_request={**envelope(),'targetUserId':protected_id,'email':protected_email}
        protected_result,_=expect('/realms/'+realm+'/dc-tenant-people/operations/'+str(uuid.uuid4())+'/steps/CREATE_IDENTITY',tenants[0]['token'],protected_request,status=200)
        if protected_result['outcome']!='REJECTED_NO_EFFECT':raise RuntimeError('PROTECTED_IDENTITY_ADOPTED')
        protected_after,_=expect(adminbase+'/users/'+protected_id,admin,status=200)
        if protected_before!=protected_after:raise RuntimeError('PROTECTED_IDENTITY_CHANGED')
        rolebody=envelope();roleoperation=str(uuid.uuid4());rolebase='/realms/'+realm+'/dc-tenant-people/operations/'+roleoperation+'/steps/'
        expect(rolebase+'CREATE_IDENTITY',tenants[0]['token'],rolebody,status=200)
        role_result,_=expect(rolebase+'TENANT_ROLE',tenants[0]['token'],rolebody,status=200)
        if role_result['outcome']!='SUCCEEDED':raise RuntimeError('TENANT_ROLE_NOT_GRANTED')
        role_replay,_=expect(rolebase+'TENANT_ROLE',tenants[0]['token'],rolebody,status=200)
        if role_replay!=role_result:raise RuntimeError('TENANT_ROLE_RECEIPT_CHANGED')
        roles,_=expect(adminbase+'/users/'+rolebody['targetUserId']+'/role-mappings/realm',admin,status=200)
        if [value['name'] for value in roles]!=['agent']:raise RuntimeError('UNEXPECTED_TENANT_ROLES')
        expect(rolebase+'TENANT_ROLE',tenants[1]['token'],rolebody,status=403)
        expect(rolebase+'TENANT_ROLE',tenants[0]['token'],{**rolebody,'role':'ADMIN'},status=409)
        organization_result,_=expect(rolebase+'ORG_MEMBERSHIP',tenants[0]['token'],rolebody,status=200)
        if organization_result['outcome']!='SUCCEEDED':raise RuntimeError('ORGANIZATION_NOT_JOINED')
        organization_replay,_=expect(rolebase+'ORG_MEMBERSHIP',tenants[0]['token'],rolebody,status=200)
        if organization_replay!=organization_result:raise RuntimeError('ORGANIZATION_RECEIPT_CHANGED')
        members,_=expect(adminbase+'/organizations/'+tenants[0]['organization']+'/members',admin,status=200)
        if rolebody['targetUserId'] not in [member['id'] for member in members]:raise RuntimeError('ORGANIZATION_MEMBER_MISSING')
        atomicbody=envelope();atomicoperation=str(uuid.uuid4());atomicbase='/realms/'+realm+'/dc-tenant-people/operations/'+atomicoperation+'/steps/'
        expect(atomicbase+'CREATE_IDENTITY',tenants[0]['token'],atomicbody,status=200)
        sql("CREATE FUNCTION dc_b2_setup_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.step IN ('TENANT_ROLE','ORG_MEMBERSHIP') THEN RAISE EXCEPTION 'B2_TEST_SETUP_FAULT'; END IF; RETURN NEW; END $$; CREATE TRIGGER dc_b2_setup_fault BEFORE INSERT ON dc_tenant_people_receipt FOR EACH ROW EXECUTE FUNCTION dc_b2_setup_fault();")
        expect(atomicbase+'TENANT_ROLE',tenants[0]['token'],atomicbody,status=503)
        atomicroles,_=expect(adminbase+'/users/'+atomicbody['targetUserId']+'/role-mappings/realm',admin,status=200)
        if atomicroles:raise RuntimeError('PARTIAL_ROLE_COMMITTED')
        sql('DROP TRIGGER dc_b2_setup_fault ON dc_tenant_people_receipt;')
        expect(atomicbase+'TENANT_ROLE',tenants[0]['token'],atomicbody,status=200)
        sql('CREATE TRIGGER dc_b2_setup_fault BEFORE INSERT ON dc_tenant_people_receipt FOR EACH ROW EXECUTE FUNCTION dc_b2_setup_fault();')
        expect(atomicbase+'ORG_MEMBERSHIP',tenants[0]['token'],atomicbody,status=503)
        atomicmembers,_=expect(adminbase+'/organizations/'+tenants[0]['organization']+'/members',admin,status=200)
        if atomicbody['targetUserId'] in [member['id'] for member in atomicmembers]:raise RuntimeError('PARTIAL_MEMBERSHIP_COMMITTED')
        sql('DROP TRIGGER dc_b2_setup_fault ON dc_tenant_people_receipt;')
        sql("CREATE FUNCTION dc_b2_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM dc_tenant_people_operation WHERE id=NEW.operation_key AND payload_digest='"+'f'*64+"') THEN RAISE EXCEPTION 'B2_TEST_RECEIPT_FAULT'; END IF; RETURN NEW; END $$; CREATE TRIGGER dc_b2_receipt_fault BEFORE INSERT ON dc_tenant_people_receipt FOR EACH ROW EXECUTE FUNCTION dc_b2_receipt_fault();")
        fault={**envelope(),'payloadDigest':'f'*64};faultpath='/realms/'+realm+'/dc-tenant-people/operations/'+str(uuid.uuid4())+'/steps/CREATE_IDENTITY'
        expect(faultpath,tenants[0]['token'],fault,status=503)
        expect(adminbase+'/users/'+fault['targetUserId'],admin,status=404)
        if sql("SELECT count(*) FROM dc_tenant_people_operation WHERE payload_digest='"+'f'*64+"';").strip()!='0':raise RuntimeError('PARTIAL_OPERATION_COMMITTED')
        try:sql('UPDATE dc_tenant_people_receipt SET outcome=outcome;')
        except subprocess.CalledProcessError:pass
        else:raise RuntimeError('RECEIPT_NOT_IMMUTABLE')
        adapter_environment=os.environ.copy()
        adapter_environment.update(B2_KEYCLOAK_ISSUER=base+'/realms/'+realm,B2_KEYCLOAK_TENANT_ID=tenants[0]['id'],B2_KEYCLOAK_CLIENT_ID=tenants[0]['clientId'],B2_KEYCLOAK_CLIENT_SECRET=tenants[0]['secret'])
        human_name='bootstrap-'+uuid.uuid4().hex+'@example.test';human_password=uuid.uuid4().hex
        _,human_headers=expect(adminbase+'/users',admin,{'username':human_name,'email':human_name,'emailVerified':True,'enabled':True,'firstName':'Synthetic','lastName':'Bootstrap','credentials':[{'type':'password','value':human_password,'temporary':False}]})
        human_id=human_headers['Location'].rsplit('/',1)[-1]
        human_role,_=expect(adminbase+'/roles/admin',admin,status=200)
        expect(adminbase+'/users/'+human_id+'/role-mappings/realm',admin,[human_role],status=204)
        member_status,_,_=call(adminbase+'/organizations/'+tenants[0]['organization']+'/members',admin,human_id)
        if member_status not in (201,204):raise RuntimeError('BOOTSTRAP_ORGANIZATION_FAILED_'+str(member_status))
        mappers=[{'name':'api-audience','protocol':'openid-connect','protocolMapper':'oidc-audience-mapper','config':{'included.custom.audience':'dcontact-api','access.token.claim':'true','id.token.claim':'false'}}]
        human_claims={'tenant_id':tenants[0]['id'],'tenant_slug':tenants[0]['slug'],'dc_user_id':human_id,'dc_identity_class':'TENANT_USER','organization':json.dumps({tenants[0]['slug']:{'tenant_id':[tenants[0]['id']]}})}
        for name,value in human_claims.items():mappers.append({'name':'boundary-'+name,'protocol':'openid-connect','protocolMapper':'oidc-hardcoded-claim-mapper','config':{'claim.name':name,'claim.value':value,'jsonType.label':'JSON' if name=='organization' else 'String','access.token.claim':'true','id.token.claim':'false'}})
        expect(adminbase+'/clients',admin,{'clientId':'b2-boundary-console','enabled':True,'publicClient':True,'directAccessGrantsEnabled':True,'fullScopeAllowed':True,'protocolMappers':mappers})
        human_status,human_login,_=call('/realms/'+realm+'/protocol/openid-connect/token',form={'grant_type':'password','client_id':'b2-boundary-console','username':human_name,'password':human_password})
        if human_status!=200:raise RuntimeError('BOOTSTRAP_LOGIN_FAILED_'+str(human_status))
        application_database='v709_provisioning_'+uuid.uuid4().hex[:12]
        sql('CREATE DATABASE '+application_database+';')
        adapter_environment.update(B2_KEYCLOAK_ADMIN_ACCESS_TOKEN=human_login['access_token'],B2_KEYCLOAK_ADMIN_SUBJECT=human_id,B2_KEYCLOAK_TENANT_SLUG=tenants[0]['slug'],B2_KEYCLOAK_ORGANIZATION_ID=tenants[0]['organization'],DATABASE_URL='postgresql://'+urllib.parse.quote(owner,safe='')+':'+urllib.parse.quote(settings['POSTGRES_PASSWORD'],safe='')+'@127.0.0.1:'+str(postgres_port)+'/'+application_database,APPLICATION_DATABASE_URL='postgresql://dcontact_app:dcontact_app@127.0.0.1:'+str(postgres_port)+'/'+application_database)
        for command in (['corepack','pnpm','db:migrate'],['corepack','pnpm','db:rls'],['corepack','pnpm','--filter','@d-contact/api','exec','tsx','--test','--test-concurrency=1','src/tenant-people-keycloak.boundary.ts','src/tenant-people-provisioning.boundary.ts']):subprocess.run(command,cwd=root,env=adapter_environment,check=True)
        print('B2_TENANT_PEOPLE_BOUNDARY_PASS')
    finally:
        if started:subprocess.run(['docker','rm','-f',container],check=True,stdout=subprocess.DEVNULL)

def main():
    root=pathlib.Path(__file__).resolve().parent.parent
    run_id=uuid.uuid4().hex[:12]
    prefix='dc-people-boundary-'+run_id
    network=prefix+'-net'
    postgres=prefix+'-pg'
    container=prefix+'-kc'
    libraries=prefix+'-libs'
    environment=os.environ.copy()
    environment['POSTGRES_PASSWORD']=uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix=prefix+'-') as temporary:
        work=pathlib.Path(temporary)
        work.chmod(0o755)
        (work/'classes').mkdir()
        try:
            for required_image in (KEYCLOAK_IMAGE,'postgres:16-alpine','eclipse-temurin:21-jdk'):
                if subprocess.run(['docker','image','inspect',required_image],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
                    subprocess.run(['docker','pull',required_image],check=True)
            subprocess.run(['docker','network','create',network],check=True,stdout=subprocess.DEVNULL)
            subprocess.run(['docker','run','-d','--pull=never','--name',postgres,'--network',network,'--memory','512m','--tmpfs','/var/lib/postgresql/data:rw,size=512m','-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD','postgres:16-alpine'],env=environment,check=True,stdout=subprocess.DEVNULL)
            for attempt in range(60):
                if subprocess.run(['docker','exec',postgres,'pg_isready','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
                time.sleep(1)
            else:raise RuntimeError('POSTGRES_STARTUP_TIMEOUT')
            published=json.loads(subprocess.check_output(['docker','inspect',postgres],text=True))[0]['NetworkSettings']['Ports']['5432/tcp'][0]
            subprocess.run(['docker','create','--name',libraries,KEYCLOAK_IMAGE],check=True,stdout=subprocess.DEVNULL)
            subprocess.run(['docker','cp',libraries+':/opt/keycloak/lib/lib/main',str(work/'lib')],check=True)
            run_boundary(root,work,postgres,network,container,published['HostPort'])
        finally:
            for owned in (container,libraries,postgres):
                subprocess.run(['docker','rm','-f',owned],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

if __name__=='__main__':
    main()
