#include "internal.h"
#include "kernels.h"
#include <float.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#ifdef QX_PROFILE
#include <emscripten/emscripten.h>
#endif

struct qx_workspace {
  uint32_t capacity,last_tokens;int busy;
#ifdef QX_PROFILE
  double profile_ms[8];
#endif
  size_t allocated;float *arena,*hidden,*temporary,*query,*key,*value,*context,*ffn,*scores;
#ifdef QX_DIAGNOSTICS
  float *stages;
#endif
};
qx_workspace *qx_workspace_create(uint32_t max_tokens) {
  if(max_tokens<2||max_tokens>QX_MAX_TOKENS) return NULL;
  qx_workspace *workspace=(qx_workspace *)calloc(1,sizeof(*workspace));if(!workspace) return NULL;
  workspace->capacity=max_tokens;
  size_t elements=(size_t)max_tokens*(6*QX_D+QX_F+1);
#ifdef QX_DIAGNOSTICS
  elements+=(size_t)max_tokens*7*QX_D;
#endif
  workspace->arena=(float *)calloc(elements,sizeof(float));
  if(!workspace->arena) {free(workspace);return NULL;}
  workspace->allocated=sizeof(*workspace)+elements*sizeof(float);
  float *cursor=workspace->arena;size_t hidden=(size_t)max_tokens*QX_D;
  workspace->hidden=cursor;cursor+=hidden;workspace->temporary=cursor;cursor+=hidden;
  workspace->query=cursor;cursor+=hidden;workspace->key=cursor;cursor+=hidden;
  workspace->value=cursor;cursor+=hidden;workspace->context=cursor;cursor+=hidden;
  workspace->ffn=cursor;cursor+=(size_t)max_tokens*QX_F;workspace->scores=cursor;cursor+=max_tokens;
#ifdef QX_DIAGNOSTICS
  workspace->stages=cursor;
#endif
  return workspace;
}
void qx_workspace_free(qx_workspace *workspace) {if(workspace) {free(workspace->arena);memset(workspace,0,sizeof(*workspace));free(workspace);}}
size_t qx_workspace_bytes(const qx_workspace *workspace) {return workspace?workspace->allocated:0;}
static void linear(const float *input,const float *weights,const float *bias,float *output,uint32_t rows,uint32_t in,uint32_t out) {
  for(uint32_t row=0;row<rows;row++) for(uint32_t column=0;column<out;column++)
    output[(size_t)row*out+column]=qx_dot(input+(size_t)row*in,weights+(size_t)column*in,in)+bias[column];
}
static void norm(float *values,const float *scale,const float *bias,uint32_t rows) {
  for(uint32_t row=0;row<rows;row++) {
    float *x=values+(size_t)row*QX_D;double sum=0,variance=0;
    for(unsigned j=0;j<QX_D;j++) sum+=x[j];double mean=sum/QX_D;
    for(unsigned j=0;j<QX_D;j++) {double delta=x[j]-mean;variance+=delta*delta;}
    double inverse=1.0/sqrt(variance/QX_D+1e-12);
    for(unsigned j=0;j<QX_D;j++) x[j]=(float)((x[j]-mean)*inverse)*scale[j]+bias[j];
  }
}
static void attention(qx_workspace *workspace,const uint32_t *mask,uint32_t tokens) {
  const float scale=0.17677669529663687f;
  for(unsigned head=0;head<12;head++) for(uint32_t row=0;row<tokens;row++) {
    const float *query=workspace->query+(size_t)row*QX_D+head*32;
    float maximum=-FLT_MAX;
    for(uint32_t key=0;key<tokens;key++) {
      float score=mask[key]?qx_dot(query,workspace->key+(size_t)key*QX_D+head*32,32)*scale:-FLT_MAX;
      workspace->scores[key]=score;if(score>maximum) maximum=score;
    }
    double total=0;
    for(uint32_t key=0;key<tokens;key++) {float value=expf(workspace->scores[key]-maximum);workspace->scores[key]=value;total+=value;}
    float *output=workspace->context+(size_t)row*QX_D+head*32;
    for(unsigned j=0;j<32;j++) output[j]=0;
    for(uint32_t key=0;key<tokens;key++) {
      float probability=(float)(workspace->scores[key]/total);
      const float *value=workspace->value+(size_t)key*QX_D+head*32;
      qx_axpy(output,value,probability,32);
    }
  }
}
static void snapshot(qx_workspace *workspace,unsigned stage,uint32_t tokens) {
#ifdef QX_DIAGNOSTICS
  memcpy(workspace->stages+(size_t)stage*workspace->capacity*QX_D,workspace->hidden,(size_t)tokens*QX_D*sizeof(float));
#else
  (void)workspace;(void)stage;(void)tokens;
#endif
}
int qx_embed_tokens(const qx_model *model,qx_workspace *workspace,const uint32_t *ids,const uint32_t *mask,uint32_t tokens,float *output) {
  if(!model||!workspace||!ids||!mask||!output) return QX_ARGUMENT;
  if(tokens<2||tokens>workspace->capacity) return QX_LIMIT;
  if(workspace->busy) return QX_BUSY;
  uint32_t real=0;
  for(uint32_t i=0;i<tokens;i++) {if(ids[i]>=QX_VOCAB||mask[i]>1) return QX_ARGUMENT;real+=mask[i];}
  if(!real||!mask[0]) return QX_ARGUMENT;
  workspace->busy=1;workspace->last_tokens=0;
#ifdef QX_PROFILE
  memset(workspace->profile_ms,0,sizeof(workspace->profile_ms));
  double profile_start=emscripten_get_now();
#define PROFILE_LAP(slot) do {double now=emscripten_get_now();workspace->profile_ms[slot]+=now-profile_start;profile_start=now;} while(0)
#else
#define PROFILE_LAP(slot) do {} while(0)
#endif
  for(uint32_t row=0;row<tokens;row++) for(unsigned j=0;j<QX_D;j++)
    workspace->hidden[(size_t)row*QX_D+j]=(model->word[(size_t)ids[row]*QX_D+j]+model->type[j])+model->position[(size_t)row*QX_D+j];
  norm(workspace->hidden,model->en_w,model->en_b,tokens);snapshot(workspace,0,tokens);PROFILE_LAP(0);
  for(unsigned layer=0;layer<6;layer++) {
    const qx_layer *l=&model->layer[layer];
    linear(workspace->hidden,l->qw,l->qb,workspace->query,tokens,QX_D,QX_D);
    linear(workspace->hidden,l->kw,l->kb,workspace->key,tokens,QX_D,QX_D);
    linear(workspace->hidden,l->vw,l->vb,workspace->value,tokens,QX_D,QX_D);
    PROFILE_LAP(1);
    attention(workspace,mask,tokens);PROFILE_LAP(2);
    linear(workspace->context,l->ow,l->ob,workspace->temporary,tokens,QX_D,QX_D);
    for(size_t j=0;j<(size_t)tokens*QX_D;j++) workspace->hidden[j]+=workspace->temporary[j];
    norm(workspace->hidden,l->an_w,l->an_b,tokens);PROFILE_LAP(3);
    linear(workspace->hidden,l->fw,l->fb,workspace->ffn,tokens,QX_D,QX_F);PROFILE_LAP(4);
    for(size_t j=0;j<(size_t)tokens*QX_F;j++) {float x=workspace->ffn[j];workspace->ffn[j]=x*0.5f*(1.0f+erff(x*0.7071067811865475244f));}
    PROFILE_LAP(5);
    linear(workspace->ffn,l->dw,l->db,workspace->temporary,tokens,QX_F,QX_D);
    for(size_t j=0;j<(size_t)tokens*QX_D;j++) workspace->hidden[j]+=workspace->temporary[j];
    norm(workspace->hidden,l->fn_w,l->fn_b,tokens);snapshot(workspace,layer+1,tokens);PROFILE_LAP(6);
  }
  double squared=0;for(unsigned j=0;j<QX_D;j++) squared+=(double)workspace->hidden[j]*workspace->hidden[j];
  double magnitude=fmax(sqrt(squared),1e-12);
  for(unsigned j=0;j<QX_D;j++) {
    output[j]=(float)(workspace->hidden[j]/magnitude);
    if(!isfinite(output[j])) {workspace->busy=0;return QX_NONFINITE;}
  }
  PROFILE_LAP(7);
#undef PROFILE_LAP
  workspace->last_tokens=tokens;workspace->busy=0;return QX_OK;
}
static int embed_text(const qx_model *model,qx_workspace *workspace,const uint8_t *text,size_t length,uint32_t role,float *output) {
  uint32_t ids[QX_MAX_TOKENS],mask[QX_MAX_TOKENS],count=0;
  int status=qx_tokenize(model,text,length,role,ids,&count);if(status) return status;
  for(uint32_t i=0;i<count;i++) mask[i]=1;
  return qx_embed_tokens(model,workspace,ids,mask,count,output);
}
int qx_embed_document(const qx_model *model,qx_workspace *workspace,const uint8_t *text,size_t length,float *output) {return embed_text(model,workspace,text,length,QX_DOCUMENT,output);}
int qx_embed_query(const qx_model *model,qx_workspace *workspace,const uint8_t *text,size_t length,float *output) {return embed_text(model,workspace,text,length,QX_QUERY,output);}
#ifdef QX_DIAGNOSTICS
const float *qx_diagnostic_stage(const qx_workspace *workspace,uint32_t stage) {
  return workspace&&workspace->last_tokens&&stage<7?workspace->stages+(size_t)stage*workspace->capacity*QX_D:NULL;
}
const float *qx_diagnostic_pooled(const qx_workspace *workspace) {return workspace&&workspace->last_tokens?workspace->hidden:NULL;}
#endif

#ifdef QX_PROFILE
double qx_profile_time(const qx_workspace *workspace,uint32_t stage) {return workspace&&stage<8?workspace->profile_ms[stage]:-1;}
#endif

uint32_t qx_backend(void) {
#ifdef QX_SIMD
  return 1;
#else
  return 0;
#endif
}
