#include "quixi_embed.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc,char **argv) {
  if(argc!=4||(strcmp(argv[2],"query")&&strcmp(argv[2],"document"))) {
    fprintf(stderr,"Usage: qx-embed MODEL.qxmodel query|document UTF8_TEXT\n");return 2;
  }
  FILE *file=fopen(argv[1],"rb");if(!file) {perror("model");return 1;}
  if(fseek(file,0,SEEK_END)) {fclose(file);return 1;}
  long size=ftell(file);if(size<=0||(unsigned long)size>QX_MAX_MODEL_BYTES) {fclose(file);fprintf(stderr,"Invalid model size\n");return 1;}
  rewind(file);uint8_t *bytes=(uint8_t *)malloc((size_t)size);
  if(!bytes) {fclose(file);return 1;}
  if(fread(bytes,1,(size_t)size,file)!=(size_t)size) {free(bytes);fclose(file);return 1;}fclose(file);
  int status;qx_model *model=qx_model_load(bytes,(size_t)size,&status);free(bytes);
  if(!model) {fprintf(stderr,"%s\n",qx_status_message(status));return 1;}
  qx_workspace *workspace=qx_workspace_create(512);
  if(!workspace) {qx_model_free(model);fprintf(stderr,"Workspace allocation failed\n");return 1;}
  float vector[384];const uint8_t *text=(const uint8_t *)argv[3];size_t length=strlen(argv[3]);
  status=!strcmp(argv[2],"query")?qx_embed_query(model,workspace,text,length,vector):qx_embed_document(model,workspace,text,length,vector);
  if(status) fprintf(stderr,"%s\n",qx_status_message(status));
  else {putchar('[');for(unsigned i=0;i<384;i++)printf("%s%.9g",i?",":"",vector[i]);puts("]");}
  qx_workspace_free(workspace);qx_model_free(model);return status?1:0;
}
