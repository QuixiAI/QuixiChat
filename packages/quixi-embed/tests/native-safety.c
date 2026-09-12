#include "../native/quixi_embed.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv) {
  assert(argc==2);FILE *file=fopen(argv[1],"rb");assert(file);
  assert(fseek(file,0,SEEK_END)==0);long size=ftell(file);assert(size>0);rewind(file);
  uint8_t *bytes=(uint8_t *)malloc((size_t)size);assert(bytes);
  assert(fread(bytes,1,(size_t)size,file)==(size_t)size);fclose(file);
  int status=0;qx_model *model=qx_model_load(bytes,(size_t)size,&status);assert(model&&status==QX_OK);
  bytes[8]=2;qx_model *wrong=qx_model_load(bytes,(size_t)size,&status);assert(!wrong&&status==QX_VERSION);free(bytes);
  qx_workspace *workspace=qx_workspace_create(512);assert(workspace);
  size_t memory=qx_workspace_bytes(workspace);float output[384],first[384];
  uint32_t ids[512],count=0,mask[512];
  const uint8_t text[]={'H','i',0,' ',0xc3,0xa9};
  assert(qx_tokenize(model,text,sizeof(text),QX_DOCUMENT,ids,&count)==QX_OK);
  for(uint32_t i=0;i<count;i++)mask[i]=1;
  for(unsigned repeat=0;repeat<10;repeat++) {
    assert(qx_embed_tokens(model,workspace,ids,mask,count,output)==QX_OK);
    if(!repeat)memcpy(first,output,sizeof(first));else assert(memcmp(first,output,sizeof(first))==0);
    assert(qx_workspace_bytes(workspace)==memory);
  }
  double norm=0;for(unsigned i=0;i<384;i++)norm+=(double)output[i]*output[i];assert(fabs(sqrt(norm)-1)<1e-5);
  assert(qx_embed_tokens(model,workspace,ids,mask,513,output)==QX_LIMIT);
  ids[0]=30522;assert(qx_embed_tokens(model,workspace,ids,mask,count,output)==QX_ARGUMENT);
  qx_workspace_free(workspace);qx_model_free(model);
  puts("Address/undefined sanitizer ownership and bounds checks passed.");return 0;
}
