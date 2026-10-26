package io.dcontact.keycloak.people;

import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.PathParam;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.QueryParam;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.common.util.Time;
import org.keycloak.authentication.actiontoken.execactions.ExecuteActionsActionToken;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailSenderProvider;
import org.keycloak.models.AbstractKeycloakTransaction;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.OrganizationModel;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.credential.OTPCredentialModel;
import org.keycloak.models.utils.KeycloakModelUtils;
import org.keycloak.models.utils.SystemClientUtil;
import org.keycloak.organization.OrganizationProvider;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.resources.LoginActionsService;
import org.keycloak.userprofile.UserProfileProvider;

@Produces(MediaType.APPLICATION_JSON)
public class PeopleResource {
  private static final Pattern UUID=Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
  private static final Set<String> FIELDS=Set.of("tenantId","targetUserId","payloadDigest","fencingToken","email","displayName","role");
  private final KeycloakSession session;
  public PeopleResource(KeycloakSession session) { this.session=session; }
  record Binding(RealmModel realm,ClientModel client,OrganizationModel organization) {}

  static Response json(int status,Object value) {
    return Response.status(status).type(MediaType.APPLICATION_JSON).header("Cache-Control","no-store").entity(value).build();
  }
  static WebApplicationException denied(int status,String code) { return new WebApplicationException(json(status,Map.of("code",code))); }
  private static String text(Map<String,Object> body,String key) {
    Object value=body==null?null:body.get(key);
    if(!(value instanceof String))throw denied(400,"INVALID_REQUEST");
    return (String)value;
  }
  static void uuid(String value) { if(value==null||!UUID.matcher(value).matches())throw denied(400,"INVALID_REQUEST"); }
  static String hash(String value) {
    try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
    catch(Exception failure) { throw new IllegalStateException("digest unavailable"); }
  }
  Binding authorize(String tenantId) {
    var auth=new AppAuthManager.BearerTokenAuthenticator(session).authenticate();
    if(auth==null)throw denied(401,"UNAUTHORIZED");
    var client=auth.client();var caller=auth.user();var realm=session.getContext().getRealm();
    if(client==null||caller==null||!client.isEnabled()||client.isPublicClient()||!client.isServiceAccountsEnabled()
      ||!client.getId().equals(caller.getServiceAccountClientLink())
      ||!client.getClientId().equals("dcontact-tenant-people-"+tenantId)
      ||!"TENANT_PEOPLE_V1".equals(client.getAttribute("dc_service_purpose"))
      ||!tenantId.equals(client.getAttribute("tenant_id"))
      ||auth.token().getAudience()==null||!Arrays.asList(auth.token().getAudience()).contains("dc-tenant-people"))throw denied(403,"FORBIDDEN");
    ClientModel management=session.clients().getClientByClientId(realm,"realm-management");
    if(management!=null&&management.getRolesStream().anyMatch(caller::hasRole))throw denied(403,"FORBIDDEN");
    if(realm.getRolesStream().filter(role->role.getName().startsWith("platform_")||Set.of("admin","supervisor","agent","create-realm").contains(role.getName())).anyMatch(caller::hasRole))throw denied(403,"FORBIDDEN");
    OrganizationProvider organizations=session.getProvider(OrganizationProvider.class);
    if(organizations==null||!organizations.isEnabled())throw denied(403,"FORBIDDEN");
    var matches=organizations.getAllStream(Map.of("tenant_id",tenantId),0,2).toList();
    if(matches.size()!=1)throw denied(403,"FORBIDDEN");
    var organization=matches.get(0);
    if(!organization.isEnabled()||!organization.getId().equals(client.getAttribute("dc_organization_id"))
      ||!organization.getAlias().equals(client.getAttribute("tenant_slug")))throw denied(403,"FORBIDDEN");
    var profile=session.getProvider(UserProfileProvider.class);
    if(profile==null)throw denied(503,"IDENTITY_PROFILE_NOT_READY");
    var configuration=profile.getConfiguration();
    for(String attribute:List.of("dc_identity_class","tenant_id","tenant_slug","dc_user_id","dc_tenant_people_operation_id")) {
      var field=configuration.getAttribute(attribute);
      if(field==null||field.isMultivalued()||field.getPermissions()==null
        ||!Set.of("admin").equals(field.getPermissions().getEdit())||!Set.of("admin").equals(field.getPermissions().getView()))throw denied(503,"IDENTITY_PROFILE_NOT_READY");
    }
    return new Binding(realm,client,organization);
  }
  private EntityManager entityManager() { return session.getProvider(JpaConnectionProvider.class).getEntityManager(); }
  String operationKey(Binding binding,String operationId) { return hash(binding.realm().getId()+":"+binding.client().getId()+":"+operationId); }
  void lockTenant(EntityManager manager,Binding binding,String tenantId) {
    String key=hash(binding.realm().getId()+":"+tenantId);
    manager.createNativeQuery("INSERT INTO DC_TENANT_PEOPLE_GATE(ID,REALM_ID,TENANT_ID) VALUES(:id,:realm,:tenant) ON CONFLICT(ID) DO NOTHING")
      .setParameter("id",key).setParameter("realm",binding.realm().getId()).setParameter("tenant",tenantId).executeUpdate();
    manager.find(TenantGate.class,key,LockModeType.PESSIMISTIC_WRITE);
  }
  private Response receipt(PeopleReceipt receipt) {
    var result=new java.util.HashMap<String,Object>();
    result.put("outcome",receipt.outcome);result.put("receiptRef",receipt.id);result.put("reasonCode",receipt.reasonCode);
    if(receipt.identityId!=null)result.put("identityId",receipt.identityId);
    return json(200,result);
  }

  @Path("disable")
  public PeopleDisableResource disable() { return new PeopleDisableResource(session,this); }

  @GET @Path("readiness")
  public Response readiness(@QueryParam("tenantId") String tenantId) {
    uuid(tenantId);
    Binding binding=authorize(tenantId);
    var allowed=Set.copyOf(Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")));
    if(!allowed.equals(Set.of("AGENT","SUPERVISOR","ADMIN")))throw denied(503,"TENANT_ROLE_NOT_READY");
    for(String role:allowed) {
      var configured=binding.realm().getRole(role.toLowerCase(Locale.ROOT));
      if(configured==null||configured.isComposite())throw denied(503,"TENANT_ROLE_NOT_READY");
    }
    return json(200,Map.of("version",1,"ready",true,"tenantId",tenantId,"invitationReady",invitationReady(binding.realm()),"disableReady",true));
  }

  @POST @Path("operations/{operationId}/steps/CREATE_IDENTITY") @Consumes(MediaType.APPLICATION_JSON)
  public Response create(@PathParam("operationId") String operationId,Map<String,Object> body) {
    String tenantId=text(body,"tenantId");uuid(tenantId);
    Binding binding=authorize(tenantId);
    uuid(operationId);
    if(!body.keySet().equals(FIELDS))throw denied(400,"INVALID_REQUEST");
    String target=text(body,"targetUserId"),payloadDigest=text(body,"payloadDigest"),email=text(body,"email"),name=text(body,"displayName"),role=text(body,"role");
    uuid(target);
    if(!payloadDigest.matches("[a-f0-9]{64}")||!Set.of("AGENT","SUPERVISOR","ADMIN").contains(role)
      ||!Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")).contains(role))throw denied(400,"INVALID_REQUEST");
    if(name.codePointCount(0,name.length())<1||name.codePointCount(0,name.length())>120||Pattern.compile("[\\p{Cc}\\p{Cf}]").matcher(name).find()
      ||!name.equals(name.strip().replaceAll("\\s+"," "))||email.length()>254||!email.matches("[^\\s@\\p{Cc}\\p{Cf}]{1,64}@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\\.[a-z0-9-]+"))throw denied(400,"INVALID_REQUEST");
    if(binding.realm().getRole(role.toLowerCase(Locale.ROOT))==null)throw denied(503,"TENANT_ROLE_NOT_READY");
    long fence;
    try { String supplied=text(body,"fencingToken");if(!supplied.matches("[1-9][0-9]{0,18}"))throw new IllegalArgumentException();fence=Long.parseLong(supplied); }
    catch(IllegalArgumentException failure) { throw denied(400,"INVALID_REQUEST"); }
    EntityManager manager=entityManager();
    lockTenant(manager,binding,tenantId);
    String key=operationKey(binding,operationId),fingerprint=hash(String.join("\n",tenantId,target,payloadDigest,email,name,role,binding.organization().getId()));
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation!=null&&(!operation.requestDigest.equals(fingerprint)||!operation.payloadDigest.equals(payloadDigest)))throw denied(409,"CORRELATION_CONFLICT");
    if(operation!=null&&fence<operation.maxFence)throw denied(409,"STALE_FENCE");
    if(operation==null) {
      operation=new PeopleOperation();operation.id=key;operation.realmId=binding.realm().getId();operation.clientId=binding.client().getId();operation.operationId=operationId;
      operation.tenantId=tenantId;operation.targetUserId=target;operation.payloadDigest=payloadDigest;operation.requestDigest=fingerprint;operation.maxFence=fence;
      manager.persist(operation);
    } else operation.maxFence=fence;
    String receiptId=hash(key+":CREATE_IDENTITY:0");
    PeopleReceipt previous=manager.find(PeopleReceipt.class,receiptId);
    if(previous!=null)return receipt(previous);
    boolean conflict=session.users().getUserById(binding.realm(),target)!=null
      ||session.users().getUserByUsername(binding.realm(),email)!=null||session.users().getUserByEmail(binding.realm(),email)!=null;
    PeopleReceipt result=new PeopleReceipt();result.id=receiptId;result.operationKey=key;result.step="CREATE_IDENTITY";result.generation=0;
    result.outcome=conflict?"REJECTED_NO_EFFECT":"SUCCEEDED";result.reasonCode=conflict?"IDENTITY_CONFLICT":"IDENTITY_CREATED";
    try {
      if(!conflict) {
        UserModel created=session.users().addUser(binding.realm(),target,email,false,false);
        created.setEmail(email);created.setEmailVerified(false);created.setFirstName(name);created.setEnabled(true);
        created.setSingleAttribute("dc_identity_class","TENANT_USER");created.setSingleAttribute("tenant_id",tenantId);
        created.setSingleAttribute("tenant_slug",binding.organization().getAlias());created.setSingleAttribute("dc_user_id",target);
        created.setSingleAttribute("dc_tenant_people_operation_id",operationId);
        for(String required:List.of("VERIFY_EMAIL","UPDATE_PASSWORD","CONFIGURE_TOTP"))created.addRequiredAction(required);
        result.identityId=created.getId();
      }
      manager.persist(result);manager.flush();
      return receipt(result);
    } catch(RuntimeException failure) {
      session.getTransactionManager().setRollbackOnly();
      throw denied(503,"IDENTITY_OUTCOME_UNKNOWN");
    }
  }

  @POST @Path("operations/{operationId}/steps/{step}") @Consumes(MediaType.APPLICATION_JSON)
  public Response configureIdentity(@PathParam("operationId") String operationId,@PathParam("step") String step,Map<String,Object> body) {
    if(!Set.of("TENANT_ROLE","ORG_MEMBERSHIP","VERIFY_MAPPING","VERIFY_PROVISIONED").contains(step))throw denied(400,"INVALID_REQUEST");
    boolean verification=step.startsWith("VERIFY_");
    String tenantId=text(body,"tenantId");uuid(tenantId);Binding binding=authorize(tenantId);uuid(operationId);
    if(!body.keySet().equals(FIELDS))throw denied(400,"INVALID_REQUEST");
    String target=text(body,"targetUserId"),payloadDigest=text(body,"payloadDigest"),email=text(body,"email"),name=text(body,"displayName"),role=text(body,"role");
    uuid(target);
    if(!Set.of("AGENT","SUPERVISOR","ADMIN").contains(role)
      ||!Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")).contains(role))throw denied(400,"INVALID_REQUEST");
    long fence;
    try { String supplied=text(body,"fencingToken");if(!supplied.matches("[1-9][0-9]{0,18}"))throw new IllegalArgumentException();fence=Long.parseLong(supplied); }
    catch(IllegalArgumentException failure) { throw denied(400,"INVALID_REQUEST"); }
    EntityManager manager=entityManager();lockTenant(manager,binding,tenantId);
    String key=operationKey(binding,operationId),fingerprint=hash(String.join("\n",tenantId,target,payloadDigest,email,name,role,binding.organization().getId()));
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation==null)throw denied(409,"CREATE_IDENTITY_REQUIRED");
    if(!operation.requestDigest.equals(fingerprint)||!operation.payloadDigest.equals(payloadDigest))throw denied(409,"CORRELATION_CONFLICT");
    if(fence<operation.maxFence)throw denied(409,"STALE_FENCE");
    operation.maxFence=fence;
    String receiptId=hash(key+":"+step+":0");PeopleReceipt previous=manager.find(PeopleReceipt.class,receiptId);
    if(previous!=null&&!verification)return receipt(previous);
    PeopleReceipt created=manager.find(PeopleReceipt.class,hash(key+":CREATE_IDENTITY:0"));
    if(created==null||!"SUCCEEDED".equals(created.outcome)||!target.equals(created.identityId))throw denied(409,"CREATE_IDENTITY_REQUIRED");
    if(!"TENANT_ROLE".equals(step)) {
      PeopleReceipt granted=manager.find(PeopleReceipt.class,hash(key+":TENANT_ROLE:0"));
      if(granted==null||!"SUCCEEDED".equals(granted.outcome)||!target.equals(granted.identityId))throw denied(409,"TENANT_ROLE_REQUIRED");
    }
    if(verification) {
      PeopleReceipt joined=manager.find(PeopleReceipt.class,hash(key+":ORG_MEMBERSHIP:0"));
      if(joined==null||!"SUCCEEDED".equals(joined.outcome)||!target.equals(joined.identityId))throw denied(409,"ORGANIZATION_MEMBERSHIP_REQUIRED");
      if("VERIFY_PROVISIONED".equals(step)) {
        PeopleReceipt verified=manager.find(PeopleReceipt.class,hash(key+":VERIFY_MAPPING:0"));
        if(verified==null||!"SUCCEEDED".equals(verified.outcome)||!target.equals(verified.identityId))throw denied(409,"IDENTITY_MAPPING_REQUIRED");
      }
    }
    UserModel user=session.users().getUserById(binding.realm(),target);
    var desired=binding.realm().getRole(role.toLowerCase(Locale.ROOT));
    if(desired==null||desired.isComposite())throw denied(503,"TENANT_ROLE_NOT_READY");
    if(user==null||user.getServiceAccountClientLink()!=null||!user.isEnabled()
      ||!KeycloakModelUtils.toLowerCaseSafe(email).equals(user.getUsername())||!KeycloakModelUtils.toLowerCaseSafe(email).equals(user.getEmail())
      ||!"TENANT_USER".equals(user.getFirstAttribute("dc_identity_class"))
      ||!tenantId.equals(user.getFirstAttribute("tenant_id"))||!target.equals(user.getFirstAttribute("dc_user_id"))
      ||!binding.organization().getAlias().equals(user.getFirstAttribute("tenant_slug"))
      ||!operationId.equals(user.getFirstAttribute("dc_tenant_people_operation_id")))throw denied(409,"IDENTITY_MAPPING_CONFLICT");
    if(user.getRoleMappingsStream().anyMatch(mapped->!mapped.getId().equals(desired.getId())))throw denied(409,"IDENTITY_ROLE_CONFLICT");
    if(!"TENANT_ROLE".equals(step)&&!user.hasRole(desired))throw denied(409,"IDENTITY_ROLE_CONFLICT");
    var memberships=session.getProvider(OrganizationProvider.class).getByMember(user).toList();
    if(memberships.size()>1||memberships.stream().anyMatch(organization->!organization.getId().equals(binding.organization().getId())))throw denied(409,"IDENTITY_ORGANIZATION_CONFLICT");
    if(verification) {
      if(memberships.size()!=1||user.isEmailVerified()||user.credentialManager().getStoredCredentialsStream().findAny().isPresent()
        ||!Set.of("VERIFY_EMAIL","UPDATE_PASSWORD","CONFIGURE_TOTP").equals(user.getRequiredActionsStream().collect(java.util.stream.Collectors.toSet())))throw denied(409,"IDENTITY_ACTIVATION_CONFLICT");
      if(previous!=null)return receipt(previous);
    }
    try {
      if("TENANT_ROLE".equals(step))user.grantRole(desired);
      else if("ORG_MEMBERSHIP".equals(step)&&memberships.isEmpty()) {
        var organizations=session.getProvider(OrganizationProvider.class);
        if(!organizations.addMember(binding.organization(),user))throw new IllegalStateException("membership not added");
      }
      PeopleReceipt result=new PeopleReceipt();result.id=receiptId;result.operationKey=key;result.step=step;result.generation=0;
      result.outcome="SUCCEEDED";result.reasonCode=verification?"IDENTITY_VERIFIED":("TENANT_ROLE".equals(step)?"TENANT_ROLE_GRANTED":"ORGANIZATION_JOINED");result.identityId=target;
      manager.persist(result);manager.flush();return receipt(result);
    } catch(RuntimeException failure) {
      session.getTransactionManager().setRollbackOnly();throw denied(503,"IDENTITY_OUTCOME_UNKNOWN");
    }
  }

  @GET @Path("operations/{operationId}/steps/{step}")
  public Response read(@PathParam("operationId") String operationId,@PathParam("step") String step,@QueryParam("tenantId") String tenantId,@QueryParam("targetUserId") String target,@QueryParam("payloadDigest") String payloadDigest) {
    if(!Set.of("CREATE_IDENTITY","TENANT_ROLE","ORG_MEMBERSHIP","VERIFY_MAPPING","VERIFY_PROVISIONED").contains(step))throw denied(400,"INVALID_REQUEST");
    uuid(tenantId);Binding binding=authorize(tenantId);uuid(operationId);uuid(target);
    if(payloadDigest==null||!payloadDigest.matches("[a-f0-9]{64}"))throw denied(400,"INVALID_REQUEST");
    EntityManager manager=entityManager();String key=operationKey(binding,operationId);
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation==null)return json(200,Map.of("outcome","UNKNOWN"));
    if(!operation.tenantId.equals(tenantId)||!operation.targetUserId.equals(target)||!operation.payloadDigest.equals(payloadDigest))throw denied(409,"CORRELATION_CONFLICT");
    PeopleReceipt result=manager.find(PeopleReceipt.class,hash(key+":"+step+":0"));
    return result==null?json(200,Map.of("outcome","UNKNOWN")):receipt(result);
  }

  @GET @Path("operations/{operationId}/activation")
  public Response activation(@PathParam("operationId") String operationId,@QueryParam("tenantId") String tenantId,
    @QueryParam("targetUserId") String target,@QueryParam("payloadDigest") String payloadDigest,
    @QueryParam("email") String email,@QueryParam("displayName") String name,@QueryParam("role") String role,
    @QueryParam("probeRef") String probeRef) {
    uuid(tenantId);Binding binding=authorize(tenantId);uuid(operationId);uuid(target);uuid(probeRef);
    if(payloadDigest==null||!payloadDigest.matches("[a-f0-9]{64}")||email==null||name==null||role==null
      ||!Set.of("AGENT","SUPERVISOR","ADMIN").contains(role))throw denied(400,"INVALID_REQUEST");
    EntityManager manager=entityManager();String key=operationKey(binding,operationId);
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation==null)return json(200,Map.of("outcome","UNKNOWN"));
    String fingerprint=hash(String.join("\n",tenantId,target,payloadDigest,email,name,role,binding.organization().getId()));
    if(!operation.tenantId.equals(tenantId)||!operation.targetUserId.equals(target)
      ||!operation.payloadDigest.equals(payloadDigest)||!operation.requestDigest.equals(fingerprint))throw denied(409,"CORRELATION_CONFLICT");
    PeopleReceipt provisioned=manager.find(PeopleReceipt.class,hash(key+":VERIFY_PROVISIONED:0"));
    if(provisioned==null||!"SUCCEEDED".equals(provisioned.outcome)||!target.equals(provisioned.identityId))return json(200,Map.of("outcome","UNKNOWN"));
    UserModel user=session.users().getUserById(binding.realm(),target);
    var desired=binding.realm().getRole(role.toLowerCase(Locale.ROOT));
    if(user==null||desired==null||desired.isComposite()||user.getServiceAccountClientLink()!=null||!user.isEnabled()
      ||!KeycloakModelUtils.toLowerCaseSafe(email).equals(user.getUsername())||!KeycloakModelUtils.toLowerCaseSafe(email).equals(user.getEmail())
      ||!"TENANT_USER".equals(user.getFirstAttribute("dc_identity_class"))
      ||!tenantId.equals(user.getFirstAttribute("tenant_id"))||!target.equals(user.getFirstAttribute("dc_user_id"))
      ||!binding.organization().getAlias().equals(user.getFirstAttribute("tenant_slug"))
      ||!operationId.equals(user.getFirstAttribute("dc_tenant_people_operation_id")))throw denied(409,"IDENTITY_MAPPING_CONFLICT");
    var roles=user.getRoleMappingsStream().toList();
    if(roles.size()!=1||!roles.get(0).getId().equals(desired.getId()))throw denied(409,"IDENTITY_ROLE_CONFLICT");
    var memberships=session.getProvider(OrganizationProvider.class).getByMember(user).toList();
    if(memberships.size()!=1||!memberships.get(0).getId().equals(binding.organization().getId()))throw denied(409,"IDENTITY_ORGANIZATION_CONFLICT");
    var credentials=user.credentialManager().getStoredCredentialsStream().toList();
    boolean password=credentials.stream().anyMatch(credential->"password".equals(credential.getType()));
    boolean totp=credentials.stream().filter(credential->"otp".equals(credential.getType()))
      .anyMatch(credential->"totp".equals(OTPCredentialModel.createFromCredentialModel(credential).getOTPCredentialData().getSubType()));
    boolean verified=user.isEmailVerified()&&user.getRequiredActionsStream().findAny().isEmpty()&&password&&totp;
    return json(200,Map.of("version",1,"outcome",verified?"VERIFIED":"PENDING","tenantId",tenantId,"operationId",operationId,
      "userId",target,"payloadDigest",payloadDigest,"probeRef",probeRef,"serverEpoch",Time.currentTime()));
  }

  private void invitationProfileReady() {
    var field=session.getProvider(UserProfileProvider.class).getConfiguration().getAttribute("dc_invitation_not_before");
    if(field==null||field.isMultivalued()||field.getPermissions()==null
      ||!Set.of("admin").equals(field.getPermissions().getEdit())||!Set.of("admin").equals(field.getPermissions().getView()))throw denied(503,"INVITATION_PROFILE_NOT_READY");
  }

  private boolean invitationReady(RealmModel realm) {
    try { invitationProfileReady(); }
    catch(WebApplicationException unavailable) {
      if(unavailable.getResponse().getStatus()==503)return false;
      throw unavailable;
    }
    var smtp=realm.getSmtpConfig();
    if(smtp==null||smtp.get("host")==null||smtp.get("host").isBlank()
      ||smtp.get("from")==null||smtp.get("from").isBlank())return false;
    String port=smtp.get("port");
    if(port==null||!port.matches("[0-9]{1,5}"))return false;
    int number=Integer.parseInt(port);
    if(number<1||number>65535)return false;
    var systemClient=SystemClientUtil.getSystemClient(realm);
    if(systemClient==null||!systemClient.isEnabled())return false;
    var sender=session.getProvider(EmailSenderProvider.class);
    return sender!=null&&"org.keycloak.email.DefaultEmailSenderProvider".equals(sender.getClass().getName());
  }

  private Response invitationIntent(PeopleOperation operation,PeopleInvitationIntent intent) {
    var result=new java.util.HashMap<String,Object>();
    result.put("outcome","INTENT");result.put("intentRef",intent.id);result.put("quiescent",false);
    result.put("tenantId",operation.tenantId);result.put("operationId",operation.operationId);result.put("userId",operation.targetUserId);
    result.put("generation",intent.generation);result.put("providerAttemptRef",intent.providerAttemptRef);
    result.put("payloadDigest",operation.payloadDigest);result.put("fencingToken",Long.toString(intent.fencingToken));
    result.put("leaseOwner",intent.leaseOwner);result.put("notBeforeEpoch",intent.notBeforeEpoch);result.put("serverEpoch",Time.currentTimeSeconds());
    return json(200,result);
  }

  private void invitationDescriptor(PeopleInvitationIntent intent,String attempt,String fence,String owner) {
    if(!intent.providerAttemptRef.equals(attempt)||!Long.toString(intent.fencingToken).equals(fence)||!intent.leaseOwner.equals(owner))throw denied(409,"CORRELATION_CONFLICT");
  }

  private long invitationGeneration(String generation) {
    if(generation==null||!generation.matches("[1-9][0-9]{0,9}"))throw denied(400,"INVALID_REQUEST");
    long number=Long.parseLong(generation);
    if(number>Integer.MAX_VALUE)throw denied(400,"INVALID_REQUEST");
    return number;
  }

  @POST @Path("operations/{operationId}/invitations/{generation}/intent") @Consumes(MediaType.APPLICATION_JSON)
  public Response prepareInvitation(@PathParam("operationId") String operationId,@PathParam("generation") String generation,Map<String,Object> body) {
    String tenantId=text(body,"tenantId");uuid(tenantId);Binding binding=authorize(tenantId);uuid(operationId);
    if(!body.keySet().equals(Set.of("tenantId","targetUserId","payloadDigest","fencingToken","email","displayName","role","providerAttemptRef","leaseOwner")))throw denied(400,"INVALID_REQUEST");
    long generationNumber=invitationGeneration(generation);
    invitationProfileReady();
    String target=text(body,"targetUserId"),payloadDigest=text(body,"payloadDigest"),email=text(body,"email"),name=text(body,"displayName"),role=text(body,"role");
    String attempt=text(body,"providerAttemptRef"),owner=text(body,"leaseOwner"),suppliedFence=text(body,"fencingToken");
    uuid(target);uuid(attempt);
    long fence;
    try { if(!suppliedFence.matches("[1-9][0-9]{0,18}"))throw new IllegalArgumentException();fence=Long.parseLong(suppliedFence); }
    catch(IllegalArgumentException failure) { throw denied(400,"INVALID_REQUEST"); }
    if(!payloadDigest.matches("[a-f0-9]{64}")||!owner.matches("[A-Za-z0-9_.:-]{1,128}"))throw denied(400,"INVALID_REQUEST");
    EntityManager manager=entityManager();lockTenant(manager,binding,tenantId);
    String key=operationKey(binding,operationId),fingerprint=hash(String.join("\n",tenantId,target,payloadDigest,email,name,role,binding.organization().getId()));
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation==null)throw denied(409,"PROVISIONING_REQUIRED");
    if(!operation.requestDigest.equals(fingerprint)||!operation.payloadDigest.equals(payloadDigest))throw denied(409,"CORRELATION_CONFLICT");
    PeopleReceipt provisioned=manager.find(PeopleReceipt.class,hash(key+":VERIFY_PROVISIONED:0"));
    if(provisioned==null||!"SUCCEEDED".equals(provisioned.outcome)||!target.equals(provisioned.identityId))throw denied(409,"PROVISIONING_REQUIRED");
    UserModel user=session.users().getUserById(binding.realm(),target);
    var desired=binding.realm().getRole(role.toLowerCase(Locale.ROOT));
    if(!Set.of("AGENT","SUPERVISOR","ADMIN").contains(role)
      ||!Arrays.asList(String.valueOf(binding.client().getAttribute("dc_allowed_roles")).split(",")).contains(role)
      ||desired==null||desired.isComposite())throw denied(503,"TENANT_ROLE_NOT_READY");
    if(user==null||user.getServiceAccountClientLink()!=null||!user.isEnabled()
      ||!KeycloakModelUtils.toLowerCaseSafe(email).equals(user.getUsername())||!KeycloakModelUtils.toLowerCaseSafe(email).equals(user.getEmail())
      ||!name.equals(user.getFirstName())||!"TENANT_USER".equals(user.getFirstAttribute("dc_identity_class"))
      ||!tenantId.equals(user.getFirstAttribute("tenant_id"))||!target.equals(user.getFirstAttribute("dc_user_id"))
      ||!binding.organization().getAlias().equals(user.getFirstAttribute("tenant_slug"))
      ||!operationId.equals(user.getFirstAttribute("dc_tenant_people_operation_id")))throw denied(409,"IDENTITY_MAPPING_CONFLICT");
    if(!user.hasRole(desired)||user.getRoleMappingsStream().anyMatch(mapped->!mapped.getId().equals(desired.getId())))throw denied(409,"IDENTITY_ROLE_CONFLICT");
    var memberships=session.getProvider(OrganizationProvider.class).getByMember(user).toList();
    if(memberships.size()!=1||!memberships.get(0).getId().equals(binding.organization().getId()))throw denied(409,"IDENTITY_ORGANIZATION_CONFLICT");
    if(user.isEmailVerified()||user.credentialManager().getStoredCredentialsStream().findAny().isPresent()
      ||!Set.of("VERIFY_EMAIL","UPDATE_PASSWORD","CONFIGURE_TOTP").equals(user.getRequiredActionsStream().collect(java.util.stream.Collectors.toSet())))throw denied(409,"IDENTITY_ACTIVATION_CONFLICT");
    String intentId=hash(key+":SEND_INTENT:"+generation);PeopleInvitationIntent previous=manager.find(PeopleInvitationIntent.class,intentId);
    var history=manager.createQuery("SELECT intent FROM PeopleInvitationIntent intent WHERE intent.operationKey=:operation ORDER BY intent.generation DESC",PeopleInvitationIntent.class)
      .setParameter("operation",key).setMaxResults(1).getResultList();
    PeopleInvitationIntent latest=history.isEmpty()?null:history.get(0);
    if(previous!=null) {
      invitationDescriptor(previous,attempt,suppliedFence,owner);
      if(latest==null||!latest.id.equals(previous.id)||!Long.toString(previous.notBeforeEpoch).equals(user.getFirstAttribute("dc_invitation_not_before")))throw denied(409,"GENERATION_FENCE_CONFLICT");
      return invitationIntent(operation,previous);
    }
    long serverEpoch=Time.currentTimeSeconds(),notBefore=serverEpoch;
    if(generationNumber==1) {
      if(latest!=null||user.getFirstAttribute("dc_invitation_not_before")!=null)throw denied(409,"GENERATION_FENCE_CONFLICT");
    } else {
      if(latest==null||generationNumber!=latest.generation+1||fence<=latest.fencingToken)throw denied(409,"INVITATION_GENERATION_CONFLICT");
      if(!Long.toString(latest.notBeforeEpoch).equals(user.getFirstAttribute("dc_invitation_not_before")))throw denied(409,"GENERATION_FENCE_CONFLICT");
      PeopleInvitationFinished finished=manager.find(PeopleInvitationFinished.class,latest.id);
      if(finished==null||!"SENT".equals(finished.outcome))throw denied(409,"INVITATION_PREVIOUS_OUTCOME_UNKNOWN");
      long recent=manager.createQuery("SELECT COUNT(intent) FROM PeopleInvitationIntent intent WHERE intent.operationKey=:operation AND intent.generation>1 AND intent.createdAtEpoch>:cutoff",Long.class)
        .setParameter("operation",key).setParameter("cutoff",serverEpoch-3600).getSingleResult();
      if(recent>=3)throw denied(429,"INVITATION_RESEND_RATE_LIMIT");
      notBefore=Math.max(serverEpoch,Math.max(latest.notBeforeEpoch,finished.issuedAtEpoch)+1);
    }
    PeopleInvitationIntent intent=new PeopleInvitationIntent();intent.id=intentId;intent.operationKey=key;intent.generation=generationNumber;
    intent.providerAttemptRef=attempt;intent.requestDigest=fingerprint;intent.fencingToken=fence;intent.leaseOwner=owner;intent.notBeforeEpoch=notBefore;intent.createdAtEpoch=serverEpoch;
    try {
      user.setSingleAttribute("dc_invitation_not_before",Long.toString(intent.notBeforeEpoch));
      manager.persist(intent);manager.flush();return invitationIntent(operation,intent);
    } catch(RuntimeException failure) {
      session.getTransactionManager().setRollbackOnly();throw denied(503,"INVITATION_OUTCOME_UNKNOWN");
    }
  }

  @GET @Path("operations/{operationId}/invitations/{generation}/intent")
  public Response readInvitationIntent(@PathParam("operationId") String operationId,@PathParam("generation") String generation,
    @QueryParam("tenantId") String tenantId,@QueryParam("targetUserId") String target,@QueryParam("payloadDigest") String payloadDigest,
    @QueryParam("providerAttemptRef") String attempt,@QueryParam("fencingToken") String fence,@QueryParam("leaseOwner") String owner) {
    return readInvitationIntent(operationId,generation,tenantId,target,payloadDigest,attempt,fence,owner,true);
  }

  private Response readInvitationIntent(String operationId,String generation,String tenantId,String target,String payloadDigest,
    String attempt,String fence,String owner,boolean requireCurrentFence) {
    uuid(tenantId);Binding binding=authorize(tenantId);uuid(operationId);uuid(target);uuid(attempt);
    invitationGeneration(generation);
    invitationProfileReady();
    if(payloadDigest==null||!payloadDigest.matches("[a-f0-9]{64}")||fence==null||!fence.matches("[1-9][0-9]{0,18}")
      ||owner==null||!owner.matches("[A-Za-z0-9_.:-]{1,128}"))throw denied(400,"INVALID_REQUEST");
    EntityManager manager=entityManager();String key=operationKey(binding,operationId);
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    if(operation==null)return json(200,Map.of("outcome","UNKNOWN"));
    if(!operation.tenantId.equals(tenantId)||!operation.targetUserId.equals(target)||!operation.payloadDigest.equals(payloadDigest))throw denied(409,"CORRELATION_CONFLICT");
    PeopleInvitationIntent intent=manager.find(PeopleInvitationIntent.class,hash(key+":SEND_INTENT:"+generation));
    if(intent==null)return json(200,Map.of("outcome","UNKNOWN"));
    invitationDescriptor(intent,attempt,fence,owner);
    UserModel user=session.users().getUserById(binding.realm(),target);
    if(user==null||(requireCurrentFence&&!Long.toString(intent.notBeforeEpoch).equals(user.getFirstAttribute("dc_invitation_not_before"))))throw denied(409,"GENERATION_FENCE_CONFLICT");
    return invitationIntent(operation,intent);
  }

  private Response invitationDelivery(PeopleOperation operation,PeopleInvitationIntent intent) {
    EntityManager manager=entityManager();
    PeopleInvitationDispatch dispatch=manager.find(PeopleInvitationDispatch.class,intent.id);
    if(dispatch==null)return json(200,Map.of("outcome","UNKNOWN"));
    PeopleInvitationFinished finished=manager.find(PeopleInvitationFinished.class,intent.id);
    var result=new java.util.HashMap<String,Object>();
    result.put("outcome",finished==null?"DISPATCHING":finished.outcome);result.put("quiescent",finished!=null);
    result.put("tenantId",operation.tenantId);result.put("operationId",operation.operationId);result.put("userId",operation.targetUserId);
    result.put("generation",intent.generation);result.put("providerAttemptRef",intent.providerAttemptRef);result.put("payloadDigest",operation.payloadDigest);
    result.put("fencingToken",Long.toString(intent.fencingToken));result.put("leaseOwner",intent.leaseOwner);result.put("notBeforeEpoch",intent.notBeforeEpoch);
    if(finished!=null) { result.put("receiptRef",finished.receiptRef);result.put("issuedAtEpoch",finished.issuedAtEpoch); }
    return json(200,result);
  }

  @POST @Path("operations/{operationId}/invitations/{generation}/dispatch") @Consumes(MediaType.APPLICATION_JSON)
  public Response dispatchInvitation(@PathParam("operationId") String operationId,@PathParam("generation") String generation,Map<String,Object> body) {
    prepareInvitation(operationId,generation,body);
    Binding binding=authorize(text(body,"tenantId"));
    EntityManager manager=entityManager();String key=operationKey(binding,operationId);
    PeopleOperation operation=manager.find(PeopleOperation.class,key);
    PeopleInvitationIntent intent=manager.find(PeopleInvitationIntent.class,hash(key+":SEND_INTENT:"+generation));
    if(Time.currentTimeSeconds()<intent.notBeforeEpoch)throw denied(409,"GENERATION_FENCE_NOT_REACHED");
    if(manager.find(PeopleInvitationDispatch.class,intent.id)!=null)return invitationDelivery(operation,intent);
    PeopleInvitationDispatch dispatch=new PeopleInvitationDispatch();dispatch.id=intent.id;dispatch.startedAtEpoch=Time.currentTimeSeconds();
    try { manager.persist(dispatch);manager.flush(); }
    catch(RuntimeException failure) { session.getTransactionManager().setRollbackOnly();throw denied(503,"INVITATION_OUTCOME_UNKNOWN"); }
    var factory=session.getKeycloakSessionFactory();var context=session.getContext();var request=context.getHttpRequest();var connection=context.getConnection();
    var accepted=Map.copyOf(body);
    session.getTransactionManager().enlistAfterCompletion(new AbstractKeycloakTransaction() {
      protected void rollbackImpl() {}
      protected void commitImpl() {
        try {
          KeycloakModelUtils.runJobInTransaction(factory,context,sendSession->{
            sendSession.getContext().setHttpRequest(request);sendSession.getContext().setConnection(connection);
            new PeopleResource(sendSession).finishInvitation(operationId,generation,accepted);
          });
        } catch(RuntimeException failure) {
          System.getLogger(PeopleResource.class.getName()).log(System.Logger.Level.WARNING,"INVITATION_FINISH_UNKNOWN:"+failure.getClass().getSimpleName());
        }
      }
    });
    return invitationDelivery(operation,intent);
  }

  private void finishInvitation(String operationId,String generation,Map<String,Object> body) {
    prepareInvitation(operationId,generation,body);
    Binding binding=authorize(text(body,"tenantId"));
    EntityManager manager=entityManager();String key=operationKey(binding,operationId);
    PeopleInvitationIntent intent=manager.find(PeopleInvitationIntent.class,hash(key+":SEND_INTENT:"+generation));
    if(manager.find(PeopleInvitationDispatch.class,intent.id)==null)throw denied(409,"DISPATCH_REQUIRED");
    if(manager.find(PeopleInvitationFinished.class,intent.id)!=null)return;
    UserModel user=session.users().getUserById(binding.realm(),text(body,"targetUserId"));
    long issuedAt=Time.currentTimeSeconds();
    if(issuedAt<intent.notBeforeEpoch)throw denied(409,"GENERATION_FENCE_NOT_REACHED");
    var systemClient=SystemClientUtil.getSystemClient(binding.realm());
    if(systemClient==null||!systemClient.isEnabled())throw denied(503,"INVITATION_CLIENT_NOT_READY");
    var sender=session.getProvider(EmailSenderProvider.class);
    if(sender==null||!"org.keycloak.email.DefaultEmailSenderProvider".equals(sender.getClass().getName()))throw denied(503,"INVITATION_SENDER_NOT_READY");
    var token=new ExecuteActionsActionToken(user.getId(),user.getEmail(),Math.toIntExact(issuedAt+259200),List.of("VERIFY_EMAIL","UPDATE_PASSWORD","CONFIGURE_TOTP"),null,systemClient.getClientId());
    var uri=session.getContext().getUri();
    String encoded=token.serialize(session,binding.realm(),uri);
    issuedAt=token.getIat();
    if(issuedAt<intent.notBeforeEpoch)throw denied(409,"GENERATION_FENCE_NOT_REACHED");
    if(token.getExp()!=issuedAt+259200) { token.exp(issuedAt+259200);encoded=session.tokens().encode(token); }
    String link=LoginActionsService.actionTokenProcessor(uri).queryParam("key",encoded).build(binding.realm().getName()).toString();
    String outcome;
    try {
      sender.send(binding.realm().getSmtpConfig(),user,
        "คำเชิญเข้าใช้งาน D-Contact [dc-attempt:"+intent.providerAttemptRef+"]",
        "ตั้งรหัสผ่าน ยืนยันอีเมล และตั้งค่า Authenticator ผ่านลิงก์นี้ภายใน 72 ชั่วโมง:\n\n"+link+"\n\nหากไม่ได้ขอใช้งาน ให้เพิกเฉยต่ออีเมลนี้",null);
      outcome="SENT";
    } catch(EmailException failure) { outcome="UNKNOWN"; }
    PeopleInvitationFinished finished=new PeopleInvitationFinished();finished.id=intent.id;finished.outcome=outcome;finished.issuedAtEpoch=issuedAt;
    finished.receiptRef=hash(intent.id+":SMTP_FINISHED:"+outcome+":"+issuedAt);
    manager.persist(finished);manager.flush();
  }

  @GET @Path("operations/{operationId}/invitations/{generation}/dispatch")
  public Response readInvitationDelivery(@PathParam("operationId") String operationId,@PathParam("generation") String generation,
    @QueryParam("tenantId") String tenantId,@QueryParam("targetUserId") String target,@QueryParam("payloadDigest") String payloadDigest,
    @QueryParam("providerAttemptRef") String attempt,@QueryParam("fencingToken") String fence,@QueryParam("leaseOwner") String owner) {
    Response validated=readInvitationIntent(operationId,generation,tenantId,target,payloadDigest,attempt,fence,owner,false);
    if(validated.getEntity() instanceof Map<?,?> result&&"UNKNOWN".equals(result.get("outcome")))return validated;
    Binding binding=authorize(tenantId);EntityManager manager=entityManager();String key=operationKey(binding,operationId);
    return invitationDelivery(manager.find(PeopleOperation.class,key),manager.find(PeopleInvitationIntent.class,hash(key+":SEND_INTENT:"+generation)));
  }
}
