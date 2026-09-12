/* Observation-only export; production C sources and allocation order are unchanged. */
#include <malloc.h>
#include <stdint.h>
uint32_t qx_heap_usage(void) {return (uint32_t)mallinfo().uordblks;}
