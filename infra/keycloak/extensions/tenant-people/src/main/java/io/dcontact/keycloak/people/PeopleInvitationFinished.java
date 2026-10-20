package io.dcontact.keycloak.people;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.Immutable;
@Entity @Immutable @Table(name="DC_TENANT_PEOPLE_INVITATION_FINISHED")
public class PeopleInvitationFinished {
  @Id @Column(name="ID",length=64) public String id;
  @Column(name="OUTCOME",nullable=false,length=32) public String outcome;
  @Column(name="ISSUED_AT_EPOCH",nullable=false) public long issuedAtEpoch;
  @Column(name="RECEIPT_REF",nullable=false,length=64) public String receiptRef;
}
