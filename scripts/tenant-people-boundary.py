import concurrent.futures
import base64
import hashlib
import http.cookiejar
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import tempfile

KEYCLOAK_IMAGE='docker.io/keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85'
MAILPIT_IMAGE='docker.io/axllent/mailpit:v1.31.1@sha256:98b916bd3c8d61f7633a52d3ea2f58d00620cb01ca57ab59edde68c347a95365'

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
    subprocess.run(['docker','run','--rm','--network','none','--user',str(os.getuid())+':'+str(os.getgid()),'-v',str(root/'infra/keycloak/extensions/invitation-guard/src/main')+':/src:ro','-v',str(work)+':/work','eclipse-temurin:21-jdk','sh','-ec','mkdir -p /work/guard-classes; javac --release 21 -proc:none -cp "/work/lib/*" -d /work/guard-classes $(find /src/java -name "*.java"); cp -r /src/resources/. /work/guard-classes/; cd /work/guard-classes; jar cf /work/dcontact-invitation-guard.jar .'],check=True)
    os.chmod(work/'dcontact-invitation-guard.jar',0o644)
    environment=os.environ.copy()
    environment.update(KC_DB_PASSWORD=settings['POSTGRES_PASSWORD'],KC_BOOTSTRAP_ADMIN_PASSWORD=uuid.uuid4().hex)
    base=None
    started=False
    smtp=container+'-smtp'
    smtp_started=False
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
        subprocess.run(['docker','run','-d','--pull=never','--name',smtp,'--network',network,'--memory','128m','--read-only','--tmpfs','/tmp:rw,size=32m','--security-opt','no-new-privileges','--cap-drop','ALL','-p','127.0.0.1::8025','-e','MP_DATABASE=/tmp/mailpit.db',MAILPIT_IMAGE],check=True,stdout=subprocess.DEVNULL)
        smtp_started=True
        smtp_port=json.loads(subprocess.check_output(['docker','inspect',smtp],text=True))[0]['NetworkSettings']['Ports']['8025/tcp'][0]['HostPort']
        def mailbox(path):
            with urllib.request.urlopen('http://127.0.0.1:'+smtp_port+path,timeout=10) as response:return json.loads(response.read())
        def messages_for_attempt(attempt):
            subject='คำเชิญเข้าใช้งาน D-Contact [dc-attempt:'+attempt+']'
            return [message for message in mailbox('/api/v1/messages').get('messages',[]) if message.get('Subject')==subject]
        args=['docker','run','-d','--pull=never','--name',container,'--network',network,'--memory','1g','--cpus','2','--security-opt','no-new-privileges','--cap-drop','ALL','-p','127.0.0.1::8080',
            '-v',str(work/'dcontact-tenant-people.jar')+':/opt/keycloak/providers/dcontact-tenant-people.jar:ro',
            '-v',str(work/'dcontact-invitation-guard.jar')+':/opt/keycloak/providers/dcontact-invitation-guard.jar:ro',
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
        expect(adminbase,admin,{'smtpServer':{'host':smtp,'port':'1025','from':'onboarding@example.test','ssl':'false','starttls':'false','auth':'false'}},method='PUT',status=204)
        for role in ('agent','supervisor','admin'):expect(adminbase+'/roles',admin,{'name':role})
        profile,_=expect(adminbase+'/users/profile',admin,status=200)
        for name in ('dc_identity_class','tenant_id','tenant_slug','dc_user_id','dc_tenant_people_operation_id','dc_invitation_not_before'):
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
        invitation_ready,_=expect(ready_path,tenants[0]['token'],status=200)
        if invitation_ready.get('invitationReady') is not True:raise RuntimeError('INVITATION_READINESS_NOT_READY')
        configured_realm,_=expect(adminbase,admin,status=200)
        smtp_configuration=configured_realm['smtpServer']
        for unavailable_smtp in ({}, {**smtp_configuration,'host':''}, {**smtp_configuration,'from':''}, {**smtp_configuration,'port':'0'}, {**smtp_configuration,'port':'65536'}, {**smtp_configuration,'port':'invalid'}):
            smtp_status,_,_=call(adminbase,admin,{'smtpServer':unavailable_smtp},method='PUT')
            if smtp_status not in (204,400):raise RuntimeError('SMTP_CONFIGURATION_UNEXPECTED_STATUS')
            unavailable_readiness,_=expect(ready_path,tenants[0]['token'],status=200)
            if unavailable_readiness.get('ready') is not True:raise RuntimeError('INVITATION_READINESS_BROKE_PROVISIONING')
            if smtp_status==204 and unavailable_readiness.get('invitationReady') is not False:raise RuntimeError('INVITATION_SMTP_READINESS_NOT_CLOSED')
            expect(adminbase,admin,{'smtpServer':smtp_configuration},method='PUT',status=204)
        expect(adminbase,admin,{'smtpServer':smtp_configuration},method='PUT',status=204)
        restored_readiness,_=expect(ready_path,tenants[0]['token'],status=200)
        if restored_readiness.get('invitationReady') is not True:raise RuntimeError('INVITATION_READINESS_NOT_RESTORED')
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
        for step in ('VERIFY_MAPPING','VERIFY_PROVISIONED'):
            expect(rolebase+step,tenants[0]['token'],rolebody,status=200)
        invitation_body={**rolebody,'providerAttemptRef':str(uuid.uuid4()),'leaseOwner':'sandbox-invitation-worker'}
        invitation_path='/realms/'+realm+'/dc-tenant-people/operations/'+roleoperation+'/invitations/1/intent'
        invitation_query=urllib.parse.urlencode({key:invitation_body[key] for key in ('tenantId','targetUserId','payloadDigest','providerAttemptRef','fencingToken','leaseOwner')})
        expect(invitation_path,None,invitation_body,status=401)
        expect(invitation_path,tenants[1]['token'],invitation_body,status=403)
        expect(invitation_path,tenants[0]['token'],{**invitation_body,'actionLink':'forbidden'},status=400)
        missing_intent,_=expect(invitation_path+'?'+invitation_query,tenants[0]['token'],status=200)
        if missing_intent!={'outcome':'UNKNOWN'}:raise RuntimeError('MISSING_INVITATION_INTENT_NOT_UNKNOWN')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            invitation_results=list(pool.map(lambda _:call(invitation_path,tenants[0]['token'],invitation_body),range(2)))
        if [result[0] for result in invitation_results]!=[200,200]:raise RuntimeError('CONCURRENT_INVITATION_INTENT_FAILED_'+str([(result[0],result[1].get('code','UNKNOWN') if isinstance(result[1],dict) else 'UNKNOWN') for result in invitation_results]))
        first_intent=invitation_results[0][1]
        expected_intent_fields={'outcome','intentRef','tenantId','operationId','userId','generation','providerAttemptRef','payloadDigest','fencingToken','leaseOwner','notBeforeEpoch','serverEpoch','quiescent'}
        if set(first_intent)!=expected_intent_fields or first_intent['outcome']!='INTENT' or first_intent['quiescent'] is not False:raise RuntimeError('INVITATION_INTENT_PROJECTION_INVALID')
        if first_intent['notBeforeEpoch']<=0 or first_intent['serverEpoch']<first_intent['notBeforeEpoch']:raise RuntimeError('KEYCLOAK_INVITATION_CLOCK_INVALID')
        for result in invitation_results:
            if {key:value for key,value in result[1].items() if key!='serverEpoch'}!={key:value for key,value in first_intent.items() if key!='serverEpoch'}:raise RuntimeError('INVITATION_INTENT_REPLAY_CHANGED')
        intent_readback,_=expect(invitation_path+'?'+invitation_query,tenants[0]['token'],status=200)
        if intent_readback['intentRef']!=first_intent['intentRef'] or intent_readback['notBeforeEpoch']!=first_intent['notBeforeEpoch']:raise RuntimeError('INVITATION_INTENT_READBACK_CHANGED')
        blocked_pending,_=expect(invitation_path.replace('/invitations/1/','/invitations/2/'),tenants[0]['token'],{**invitation_body,'providerAttemptRef':str(uuid.uuid4()),'fencingToken':str(int(invitation_body['fencingToken'])+1)},status=409)
        if blocked_pending.get('code')!='INVITATION_PREVIOUS_OUTCOME_UNKNOWN':raise RuntimeError('GENERATION_PENDING_NOT_BLOCKED_BY_OUTCOME')
        fenced_user,_=expect(adminbase+'/users/'+rolebody['targetUserId'],admin,status=200)
        if fenced_user['attributes'].get('dc_invitation_not_before')!=[str(first_intent['notBeforeEpoch'])]:raise RuntimeError('INVITATION_FENCE_NOT_DURABLE')
        if sql("SELECT count(*) FROM dc_tenant_people_invitation_intent;").strip()!='1':raise RuntimeError('DUPLICATE_INVITATION_INTENT')
        expect(invitation_path,tenants[0]['token'],{**invitation_body,'providerAttemptRef':str(uuid.uuid4())},status=409)
        expect(invitation_path,tenants[0]['token'],{**invitation_body,'leaseOwner':'different-owner'},status=409)
        expect(invitation_path,tenants[0]['token'],{**invitation_body,'fencingToken':'2'},status=409)
        expect(invitation_path.replace('/invitations/1/','/invitations/2/'),tenants[0]['token'],invitation_body,status=409)
        try:sql('UPDATE dc_tenant_people_invitation_intent SET lease_owner=lease_owner;')
        except subprocess.CalledProcessError:pass
        else:raise RuntimeError('INVITATION_INTENT_NOT_IMMUTABLE')
        missing_invitation_profile={**profile,'attributes':[attribute for attribute in profile['attributes'] if attribute['name']!='dc_invitation_not_before']}
        expect(adminbase+'/users/profile',admin,missing_invitation_profile,method='PUT',status=200)
        invitation_unready,_=expect(ready_path,tenants[0]['token'],status=200)
        if invitation_unready.get('ready') is not True or invitation_unready.get('invitationReady') is not False:raise RuntimeError('INVITATION_PROFILE_READINESS_NOT_CLOSED')
        expect(invitation_path,tenants[0]['token'],invitation_body,status=503)
        expect(adminbase+'/users/profile',admin,profile,method='PUT',status=200)
        rollback_body=envelope();rollback_operation=str(uuid.uuid4());rollback_base='/realms/'+realm+'/dc-tenant-people/operations/'+rollback_operation+'/steps/'
        for step in ('CREATE_IDENTITY','TENANT_ROLE','ORG_MEMBERSHIP','VERIFY_MAPPING','VERIFY_PROVISIONED'):
            expect(rollback_base+step,tenants[0]['token'],rollback_body,status=200)
        rollback_intent={**rollback_body,'providerAttemptRef':str(uuid.uuid4()),'leaseOwner':'sandbox-rollback-worker'}
        rollback_path='/realms/'+realm+'/dc-tenant-people/operations/'+rollback_operation+'/invitations/1/intent'
        sql("CREATE FUNCTION dc_b3_intent_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'B3_TEST_INTENT_FAULT'; END $$; CREATE TRIGGER dc_b3_intent_fault BEFORE INSERT ON dc_tenant_people_invitation_intent FOR EACH ROW EXECUTE FUNCTION dc_b3_intent_fault();")
        expect(rollback_path,tenants[0]['token'],rollback_intent,status=503)
        rollback_user,_=expect(adminbase+'/users/'+rollback_body['targetUserId'],admin,status=200)
        if 'dc_invitation_not_before' in rollback_user.get('attributes',{}):raise RuntimeError('PARTIAL_INVITATION_FENCE_COMMITTED')
        if sql('SELECT count(*) FROM dc_tenant_people_invitation_intent;').strip()!='1':raise RuntimeError('PARTIAL_INVITATION_INTENT_COMMITTED')
        sql('DROP TRIGGER dc_b3_intent_fault ON dc_tenant_people_invitation_intent;')
        expect(rollback_path,tenants[0]['token'],rollback_intent,status=200)
        subprocess.run(['docker','restart',container],check=True,stdout=subprocess.DEVNULL)
        restarted_port=json.loads(subprocess.check_output(['docker','inspect',container],text=True))[0]['NetworkSettings']['Ports']['8080/tcp'][0]
        base='http://127.0.0.1:'+restarted_port['HostPort']
        restart_deadline=time.monotonic()+120
        while time.monotonic()<restart_deadline:
            try:
                if call('/realms/'+realm+'/.well-known/openid-configuration')[0]==200:break
            except Exception:pass
            time.sleep(1)
        else:raise RuntimeError('KEYCLOAK_RESTART_TIMEOUT')
        status,login,_=call('/realms/master/protocol/openid-connect/token',form={'grant_type':'password','client_id':'admin-cli','username':'b2-boundary-admin','password':environment['KC_BOOTSTRAP_ADMIN_PASSWORD']})
        if status!=200:raise RuntimeError('SANDBOX_ADMIN_RELOGIN_FAILED')
        admin=login['access_token']
        for tenant in tenants:
            status,login,_=call('/realms/'+realm+'/protocol/openid-connect/token',form={'grant_type':'client_credentials','client_id':tenant['clientId'],'client_secret':tenant['secret']})
            if status!=200:raise RuntimeError('SANDBOX_SERVICE_RELOGIN_FAILED')
            tenant['token']=login['access_token']
        restarted_intent,_=expect(invitation_path+'?'+invitation_query,tenants[0]['token'],status=200)
        if restarted_intent['intentRef']!=first_intent['intentRef'] or restarted_intent['notBeforeEpoch']!=first_intent['notBeforeEpoch'] or restarted_intent['quiescent'] is not False:raise RuntimeError('INVITATION_INTENT_RESTART_MISMATCH')
        print('B3_INVITATION_INTENT_BOUNDARY_PASS')
        dispatch_path=invitation_path.replace('/intent','/dispatch')
        expect(dispatch_path,None,invitation_body,status=401)
        expect(dispatch_path,tenants[1]['token'],invitation_body,status=403)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            dispatch_results=list(pool.map(lambda _:call(dispatch_path,tenants[0]['token'],invitation_body),range(2)))
        if [result[0] for result in dispatch_results]!=[200,200]:raise RuntimeError('CONCURRENT_SMTP_DISPATCH_FAILED')
        delivery,_=expect(dispatch_path+'?'+invitation_query,tenants[0]['token'],status=200)
        if delivery['outcome']!='SENT' or delivery.get('quiescent') is not True:raise RuntimeError('SMTP_FINISHED_RECEIPT_MISSING')
        if delivery['providerAttemptRef']!=invitation_body['providerAttemptRef'] or delivery['leaseOwner']!=invitation_body['leaseOwner'] or delivery['fencingToken']!=invitation_body['fencingToken']:raise RuntimeError('SMTP_RECEIPT_ATTEMPT_MISMATCH')
        message_deadline=time.monotonic()+10
        while time.monotonic()<message_deadline:
            messages=messages_for_attempt(invitation_body['providerAttemptRef'])
            if messages:break
            time.sleep(0.1)
        if len(messages)!=1:raise RuntimeError('SMTP_DUPLICATE_OR_MISSING_MESSAGE')
        message=mailbox('/api/v1/message/'+messages[0]['ID'])
        link_match=re.search(r'https?://\S+action-token\S+',message.get('Text',''))
        if not link_match:raise RuntimeError('SMTP_ACTION_LINK_MISSING')
        action_key=urllib.parse.parse_qs(urllib.parse.urlparse(link_match[0]).query).get('key',[''])[0]
        token_payload=action_key.split('.')[1]
        claims=json.loads(base64.urlsafe_b64decode(token_payload+'='*((-len(token_payload))%4)))
        if claims.get('sub')!=rolebody['targetUserId'] or set(claims.get('rqac',[]))!={'VERIFY_EMAIL','UPDATE_PASSWORD','CONFIGURE_TOTP'}:raise RuntimeError('SMTP_REQUIRED_ACTIONS_INVALID')
        if claims['exp']-claims['iat']!=259200 or claims['iat']<delivery['notBeforeEpoch'] or claims['iat']!=delivery['issuedAtEpoch']:raise RuntimeError('SMTP_ACTION_TOKEN_CLOCK_INVALID')
        action_path=urllib.parse.urlparse(link_match[0]).path+'?'+urllib.parse.urlparse(link_match[0]).query
        action_browser=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        def action_page():
            try:
                with action_browser.open(urllib.request.Request(base+action_path,headers={'Accept-Language':'en'}),timeout=20) as response:
                    return response.status,response.read().decode()
            except urllib.error.HTTPError as failure:
                return failure.code,failure.read().decode()
            except Exception:
                raise RuntimeError('INVITATION_ACTION_PAGE_UNAVAILABLE') from None
        guarded_user,_=expect(adminbase+'/users/'+rolebody['targetUserId'],admin,status=200)
        original_attributes=guarded_user['attributes']
        expect(adminbase+'/users/'+rolebody['targetUserId'],admin,{**guarded_user,'attributes':{**original_attributes,'dc_invitation_not_before':[str(claims['iat']+1)]}},method='PUT',status=204)
        fenced_readback,_=expect(adminbase+'/users/'+rolebody['targetUserId'],admin,status=200)
        if fenced_readback.get('email')!=guarded_user['email'] or set(fenced_readback.get('requiredActions',[]))!=set(guarded_user['requiredActions']) or fenced_readback['attributes'].get('dc_invitation_not_before')!=[str(claims['iat']+1)]:raise RuntimeError('INVITATION_GUARD_FIXTURE_IDENTITY_DRIFT')
        superseded_status,superseded_page=action_page()
        if superseded_status!=400 or 'kc-error-message' not in superseded_page or 'Action expired' not in superseded_page:raise RuntimeError('INVITATION_SUPERSEDED_LINK_NOT_REJECTED')
        expect(adminbase+'/users/'+rolebody['targetUserId'],admin,guarded_user,method='PUT',status=204)
        restored_status,restored_page=action_page()
        if restored_status!=200 or 'kc-error-message' in restored_page:raise RuntimeError('INVITATION_PENDING_LINK_NOT_RESTORED')
        print('B3_INVITATION_ACTION_GUARD_BOUNDARY_PASS')
        if set(delivery)!={'outcome','receiptRef','quiescent','tenantId','operationId','userId','generation','providerAttemptRef','payloadDigest','fencingToken','leaseOwner','notBeforeEpoch','issuedAtEpoch'}:raise RuntimeError('SMTP_RECEIPT_PROJECTION_INVALID')
        different_attempt_query=urllib.parse.urlencode({**{key:invitation_body[key] for key in ('tenantId','targetUserId','payloadDigest','providerAttemptRef','fencingToken','leaseOwner')},'providerAttemptRef':str(uuid.uuid4())})
        expect(dispatch_path+'?'+different_attempt_query,tenants[0]['token'],status=409)
        expect(dispatch_path,tenants[0]['token'],invitation_body,status=200)
        if len(messages_for_attempt(invitation_body['providerAttemptRef']))!=1:raise RuntimeError('SMTP_REPLAY_SENT_AGAIN')
        sql("CREATE FUNCTION dc_b3_finish_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'B3_TEST_FINISHED_FAULT'; END $$; CREATE TRIGGER dc_b3_finish_fault BEFORE INSERT ON dc_tenant_people_invitation_finished FOR EACH ROW EXECUTE FUNCTION dc_b3_finish_fault();")
        failed_dispatch=rollback_path.replace('/intent','/dispatch')
        expect(failed_dispatch,tenants[0]['token'],rollback_intent,status=200)
        expect(failed_dispatch,tenants[0]['token'],rollback_intent,status=200)
        sql('DROP TRIGGER dc_b3_finish_fault ON dc_tenant_people_invitation_finished;')
        failed_query=urllib.parse.urlencode({key:rollback_intent[key] for key in ('tenantId','targetUserId','payloadDigest','providerAttemptRef','fencingToken','leaseOwner')})
        unresolved,_=expect(failed_dispatch+'?'+failed_query,tenants[0]['token'],status=200)
        if unresolved.get('outcome')!='DISPATCHING' or unresolved.get('quiescent') is not False:raise RuntimeError('SMTP_RECEIPT_LOSS_NOT_UNKNOWN')
        expect(failed_dispatch,tenants[0]['token'],rollback_intent,status=200)
        if len(messages_for_attempt(rollback_intent['providerAttemptRef']))!=1:raise RuntimeError('SMTP_RECEIPT_LOSS_SENT_AGAIN')
        pending_actions_user,_=expect(adminbase+'/users/'+rollback_body['targetUserId'],admin,status=200)
        completed_message=mailbox('/api/v1/message/'+messages_for_attempt(rollback_intent['providerAttemptRef'])[0]['ID'])
        completed_link=re.search(r'https?://\S+action-token\S+',completed_message.get('Text',''))
        if not completed_link:raise RuntimeError('INVITATION_COMPLETED_ACTIONS_FIXTURE_LINK_MISSING')
        parsed_completed_link=urllib.parse.urlparse(completed_link[0])
        action_path=parsed_completed_link.path+'?'+parsed_completed_link.query
        action_browser=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        expect(adminbase+'/users/'+rollback_body['targetUserId'],admin,{**pending_actions_user,'requiredActions':[]},method='PUT',status=204)
        completed_status,completed_page=action_page()
        if completed_status!=400 or 'kc-error-message' not in completed_page or 'Action expired' not in completed_page:raise RuntimeError('INVITATION_COMPLETED_ACTIONS_LINK_NOT_REJECTED')
        expect(adminbase+'/users/'+rollback_body['targetUserId'],admin,pending_actions_user,method='PUT',status=204)
        print('B3_INVITATION_COMPLETED_ACTIONS_GUARD_BOUNDARY_PASS')
        for table in ('dc_tenant_people_invitation_dispatch','dc_tenant_people_invitation_finished'):
            try:sql('UPDATE '+table+' SET id=id;')
            except subprocess.CalledProcessError:pass
            else:raise RuntimeError('SMTP_PROVIDER_LEDGER_NOT_IMMUTABLE')
        print('B3_INVITATION_SMTP_BOUNDARY_PASS')
        generation_body=envelope();generation_operation=str(uuid.uuid4())
        generation_base='/realms/'+realm+'/dc-tenant-people/operations/'+generation_operation
        for step in ('CREATE_IDENTITY','TENANT_ROLE','ORG_MEMBERSHIP','VERIFY_MAPPING','VERIFY_PROVISIONED'):
            expect(generation_base+'/steps/'+step,tenants[0]['token'],generation_body,status=200)
        def generation_query(body):
            return urllib.parse.urlencode({key:body[key] for key in ('tenantId','targetUserId','payloadDigest','providerAttemptRef','fencingToken','leaseOwner')})
        def generation_delivery(number,body):
            path=generation_base+'/invitations/'+str(number)+'/dispatch'
            expect(path,tenants[0]['token'],body,status=200)
            for attempt in range(50):
                proof,_=expect(path+'?'+generation_query(body),tenants[0]['token'],status=200)
                if proof.get('outcome')=='SENT' and proof.get('quiescent') is True:return proof
                time.sleep(0.1)
            raise RuntimeError('GENERATION_DELIVERY_NOT_FINISHED')
        def generation_link(body):
            messages=messages_for_attempt(body['providerAttemptRef'])
            if len(messages)!=1:raise RuntimeError('GENERATION_MAIL_NOT_EXACT_ATTEMPT')
            message=mailbox('/api/v1/message/'+messages[0]['ID'])
            link=re.search(r'https?://\S+action-token\S+',message.get('Text',''))
            if not link:raise RuntimeError('GENERATION_ACTION_LINK_MISSING')
            parsed=urllib.parse.urlparse(link[0])
            return parsed.path+'?'+parsed.query
        current_body={**generation_body,'providerAttemptRef':str(uuid.uuid4()),'leaseOwner':'generation-worker'}
        previous_delivery=generation_delivery(1,current_body)
        old_generation_link=generation_link(current_body)
        first_generation_body=current_body
        for number in (2,3,4):
            next_body={**generation_body,'providerAttemptRef':str(uuid.uuid4()),'leaseOwner':'generation-worker','fencingToken':str(int(current_body['fencingToken'])+1)}
            next_path=generation_base+'/invitations/'+str(number)+'/intent'
            if number==2:
                expect(next_path.replace('/invitations/2/','/invitations/3/'),tenants[0]['token'],next_body,status=409)
            if number==4:
                competitors=[next_body,{**next_body,'providerAttemptRef':str(uuid.uuid4())}]
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    competing=list(pool.map(lambda body:call(next_path,tenants[0]['token'],body),competitors))
                if sorted(result[0] for result in competing)!=[200,409]:raise RuntimeError('GENERATION_LAST_RESEND_SLOT_RACE_FAILED')
                next_body=competitors[next(index for index,result in enumerate(competing) if result[0]==200)]
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                prepared=list(pool.map(lambda _:call(next_path,tenants[0]['token'],next_body),range(2)))
            if [result[0] for result in prepared]!=[200,200]:raise RuntimeError('GENERATION_CONCURRENT_PREPARE_FAILED')
            intent=prepared[0][1]
            if intent.get('generation')!=number or intent['notBeforeEpoch']<=max(previous_delivery['notBeforeEpoch'],previous_delivery['issuedAtEpoch']):raise RuntimeError('GENERATION_FENCE_NOT_MONOTONIC')
            if any({key:value for key,value in result[1].items() if key!='serverEpoch'}!={key:value for key,value in intent.items() if key!='serverEpoch'} for result in prepared):raise RuntimeError('GENERATION_INTENT_REPLAY_CHANGED')
            if messages_for_attempt(next_body['providerAttemptRef']):raise RuntimeError('GENERATION_PREPARE_SENT_EMAIL')
            expect(next_path,tenants[0]['token'],{**next_body,'providerAttemptRef':str(uuid.uuid4())},status=409)
            expect(generation_base+'/invitations/1/dispatch',tenants[0]['token'],first_generation_body,status=409)
            historical,_=expect(generation_base+'/invitations/1/dispatch?'+generation_query(first_generation_body),tenants[0]['token'],status=200)
            if historical.get('outcome')!='SENT' or historical.get('quiescent') is not True or historical.get('providerAttemptRef')!=first_generation_body['providerAttemptRef']:raise RuntimeError('GENERATION_HISTORICAL_RECEIPT_UNREADABLE')
            for attempt in range(50):
                readback,_=expect(next_path+'?'+generation_query(next_body),tenants[0]['token'],status=200)
                if readback['notBeforeEpoch']!=intent['notBeforeEpoch']:raise RuntimeError('GENERATION_FENCE_READBACK_DRIFT')
                if readback['serverEpoch']>=intent['notBeforeEpoch']:break
                time.sleep(0.1)
            else:raise RuntimeError('GENERATION_SERVER_CLOCK_NOT_REACHED')
            previous_delivery=generation_delivery(number,next_body)
            if previous_delivery['issuedAtEpoch']<intent['notBeforeEpoch']:raise RuntimeError('GENERATION_ISSUED_BEFORE_FENCE')
            generation_delivery(number,next_body)
            generation_link(next_body)
            current_body=next_body
        over_limit={**generation_body,'providerAttemptRef':str(uuid.uuid4()),'leaseOwner':'generation-worker','fencingToken':str(int(current_body['fencingToken'])+1)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            rejected=list(pool.map(lambda body:call(generation_base+'/invitations/5/intent',tenants[0]['token'],body),[over_limit,{**over_limit,'providerAttemptRef':str(uuid.uuid4())}]))
        if any(result[0]!=429 or result[1].get('code')!='INVITATION_RESEND_RATE_LIMIT' for result in rejected):raise RuntimeError('GENERATION_RESEND_CAP_NOT_ENFORCED')
        blocked_unknown,_=expect(failed_dispatch.replace('/invitations/1/dispatch','/invitations/2/intent'),tenants[0]['token'],{**rollback_intent,'providerAttemptRef':str(uuid.uuid4()),'fencingToken':str(int(rollback_intent['fencingToken'])+1)},status=409)
        if blocked_unknown.get('code')!='INVITATION_PREVIOUS_OUTCOME_UNKNOWN':raise RuntimeError('GENERATION_AMBIGUITY_NOT_BLOCKED_BY_OUTCOME')
        action_path=old_generation_link
        action_browser=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        old_status,old_page=action_page()
        if old_status!=400 or 'Action expired' not in old_page:raise RuntimeError('PROVIDER_SUPERSEDED_LINK_NOT_REJECTED')
        action_path=generation_link(current_body)
        action_browser=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        newest_status,newest_page=action_page()
        if newest_status!=200 or 'kc-error-message' in newest_page:raise RuntimeError('PROVIDER_NEWEST_LINK_NOT_USABLE')
        print('B3_INVITATION_GENERATION_BOUNDARY_PASS')
        atomicbody=envelope();atomicoperation=str(uuid.uuid4());atomicbase='/realms/'+realm+'/dc-tenant-people/operations/'+atomicoperation+'/steps/'
        expect(atomicbase+'CREATE_IDENTITY',tenants[0]['token'],atomicbody,status=200)
        expect('/realms/'+realm+'/dc-tenant-people/operations/'+atomicoperation+'/invitations/1/intent',tenants[0]['token'],{**atomicbody,'providerAttemptRef':str(uuid.uuid4()),'leaseOwner':'not-provisioned-worker'},status=409)
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
        if smtp_started:subprocess.run(['docker','rm','-f',smtp],check=True,stdout=subprocess.DEVNULL)

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
            for required_image in (KEYCLOAK_IMAGE,MAILPIT_IMAGE,'postgres:16-alpine','eclipse-temurin:21-jdk'):
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
            for owned in (container,container+'-smtp',libraries,postgres):
                subprocess.run(['docker','rm','-f',owned],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

if __name__=='__main__':
    main()
