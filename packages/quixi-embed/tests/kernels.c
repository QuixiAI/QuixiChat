#include "../native/kernels.h"
float qx_test_dot(const float *a,const float *b,uint32_t count) {return qx_dot(a,b,count);}
void qx_test_axpy(float *output,const float *value,float probability,uint32_t count) {qx_axpy(output,value,probability,count);}
