

/* this ALWAYS GENERATED file contains the definitions for the interfaces */


 /* File created by MIDL compiler version 8.01.0628 */
/* at Mon Jan 18 19:14:07 2038
 */
/* Compiler settings for AccessibleHyperlink.idl:
    Oicf, W1, Zp8, env=Win64 (32b run), target_arch=ARM64 8.01.0628 
    protocol : dce , ms_ext, c_ext, robust
    error checks: allocation ref bounds_check enum stub_data 
    VC __declspec() decoration level: 
         __declspec(uuid()), __declspec(selectany), __declspec(novtable)
         DECLSPEC_UUID(), MIDL_INTERFACE()
*/
/* @@MIDL_FILE_HEADING(  ) */

#pragma warning( disable: 4049 )  /* more than 64k source lines */


/* verify that the <rpcndr.h> version is high enough to compile this file*/
#ifndef __REQUIRED_RPCNDR_H_VERSION__
#define __REQUIRED_RPCNDR_H_VERSION__ 475
#endif

#include "rpc.h"
#include "rpcndr.h"

#ifndef __RPCNDR_H_VERSION__
#error this stub requires an updated version of <rpcndr.h>
#endif /* __RPCNDR_H_VERSION__ */

#ifndef COM_NO_WINDOWS_H
#include "windows.h"
#include "ole2.h"
#endif /*COM_NO_WINDOWS_H*/

#ifndef __AccessibleHyperlink_h__
#define __AccessibleHyperlink_h__

#if defined(_MSC_VER) && (_MSC_VER >= 1020)
#pragma once
#endif

#ifndef DECLSPEC_XFGVIRT
#if defined(_CONTROL_FLOW_GUARD_XFG)
#define DECLSPEC_XFGVIRT(base, func) __declspec(xfg_virtual(base, func))
#else
#define DECLSPEC_XFGVIRT(base, func)
#endif
#endif

/* Forward Declarations */ 

#ifndef __IAccessibleHyperlink_FWD_DEFINED__
#define __IAccessibleHyperlink_FWD_DEFINED__
typedef interface IAccessibleHyperlink IAccessibleHyperlink;

#endif 	/* __IAccessibleHyperlink_FWD_DEFINED__ */


/* header files for imported files */
#include "objidl.h"
#include "oaidl.h"
#include "oleacc.h"
#include "AccessibleAction.h"

#ifdef __cplusplus
extern "C"{
#endif 


#ifndef __IAccessibleHyperlink_INTERFACE_DEFINED__
#define __IAccessibleHyperlink_INTERFACE_DEFINED__

/* interface IAccessibleHyperlink */
/* [uuid][object] */ 


EXTERN_C const IID IID_IAccessibleHyperlink;

#if defined(__cplusplus) && !defined(CINTERFACE)
    
    MIDL_INTERFACE("01C20F2B-3DD2-400f-949F-AD00BDAB1D41")
    IAccessibleHyperlink : public IAccessibleAction
    {
    public:
        virtual /* [propget] */ HRESULT STDMETHODCALLTYPE get_anchor( 
            /* [in] */ long index,
            /* [retval][out] */ VARIANT *anchor) = 0;
        
        virtual /* [propget] */ HRESULT STDMETHODCALLTYPE get_anchorTarget( 
            /* [in] */ long index,
            /* [retval][out] */ VARIANT *anchorTarget) = 0;
        
        virtual /* [propget] */ HRESULT STDMETHODCALLTYPE get_startIndex( 
            /* [retval][out] */ long *index) = 0;
        
        virtual /* [propget] */ HRESULT STDMETHODCALLTYPE get_endIndex( 
            /* [retval][out] */ long *index) = 0;
        
        virtual /* [propget] */ HRESULT STDMETHODCALLTYPE get_valid( 
            /* [retval][out] */ boolean *valid) = 0;
        
    };
    
    
#else 	/* C style interface */

    typedef struct IAccessibleHyperlinkVtbl
    {
        BEGIN_INTERFACE
        
        DECLSPEC_XFGVIRT(IUnknown, QueryInterface)
        HRESULT ( STDMETHODCALLTYPE *QueryInterface )( 
            IAccessibleHyperlink * This,
            /* [in] */ REFIID riid,
            /* [annotation][iid_is][out] */ 
            _COM_Outptr_  void **ppvObject);
        
        DECLSPEC_XFGVIRT(IUnknown, AddRef)
        ULONG ( STDMETHODCALLTYPE *AddRef )( 
            IAccessibleHyperlink * This);
        
        DECLSPEC_XFGVIRT(IUnknown, Release)
        ULONG ( STDMETHODCALLTYPE *Release )( 
            IAccessibleHyperlink * This);
        
        DECLSPEC_XFGVIRT(IAccessibleAction, nActions)
        HRESULT ( STDMETHODCALLTYPE *nActions )( 
            IAccessibleHyperlink * This,
            /* [retval][out] */ long *nActions);
        
        DECLSPEC_XFGVIRT(IAccessibleAction, doAction)
        HRESULT ( STDMETHODCALLTYPE *doAction )( 
            IAccessibleHyperlink * This,
            /* [in] */ long actionIndex);
        
        DECLSPEC_XFGVIRT(IAccessibleAction, get_description)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_description )( 
            IAccessibleHyperlink * This,
            /* [in] */ long actionIndex,
            /* [retval][out] */ BSTR *description);
        
        DECLSPEC_XFGVIRT(IAccessibleAction, get_keyBinding)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_keyBinding )( 
            IAccessibleHyperlink * This,
            /* [in] */ long actionIndex,
            /* [in] */ long nMaxBindings,
            /* [length_is][length_is][size_is][size_is][out] */ BSTR **keyBindings,
            /* [retval][out] */ long *nBindings);
        
        DECLSPEC_XFGVIRT(IAccessibleAction, get_name)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_name )( 
            IAccessibleHyperlink * This,
            /* [in] */ long actionIndex,
            /* [retval][out] */ BSTR *name);
        
        DECLSPEC_XFGVIRT(IAccessibleAction, get_localizedName)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_localizedName )( 
            IAccessibleHyperlink * This,
            /* [in] */ long actionIndex,
            /* [retval][out] */ BSTR *localizedName);
        
        DECLSPEC_XFGVIRT(IAccessibleHyperlink, get_anchor)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_anchor )( 
            IAccessibleHyperlink * This,
            /* [in] */ long index,
            /* [retval][out] */ VARIANT *anchor);
        
        DECLSPEC_XFGVIRT(IAccessibleHyperlink, get_anchorTarget)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_anchorTarget )( 
            IAccessibleHyperlink * This,
            /* [in] */ long index,
            /* [retval][out] */ VARIANT *anchorTarget);
        
        DECLSPEC_XFGVIRT(IAccessibleHyperlink, get_startIndex)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_startIndex )( 
            IAccessibleHyperlink * This,
            /* [retval][out] */ long *index);
        
        DECLSPEC_XFGVIRT(IAccessibleHyperlink, get_endIndex)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_endIndex )( 
            IAccessibleHyperlink * This,
            /* [retval][out] */ long *index);
        
        DECLSPEC_XFGVIRT(IAccessibleHyperlink, get_valid)
        /* [propget] */ HRESULT ( STDMETHODCALLTYPE *get_valid )( 
            IAccessibleHyperlink * This,
            /* [retval][out] */ boolean *valid);
        
        END_INTERFACE
    } IAccessibleHyperlinkVtbl;

    interface IAccessibleHyperlink
    {
        CONST_VTBL struct IAccessibleHyperlinkVtbl *lpVtbl;
    };

    

#ifdef COBJMACROS


#define IAccessibleHyperlink_QueryInterface(This,riid,ppvObject)	\
    ( (This)->lpVtbl -> QueryInterface(This,riid,ppvObject) ) 

#define IAccessibleHyperlink_AddRef(This)	\
    ( (This)->lpVtbl -> AddRef(This) ) 

#define IAccessibleHyperlink_Release(This)	\
    ( (This)->lpVtbl -> Release(This) ) 


#define IAccessibleHyperlink_nActions(This,nActions)	\
    ( (This)->lpVtbl -> nActions(This,nActions) ) 

#define IAccessibleHyperlink_doAction(This,actionIndex)	\
    ( (This)->lpVtbl -> doAction(This,actionIndex) ) 

#define IAccessibleHyperlink_get_description(This,actionIndex,description)	\
    ( (This)->lpVtbl -> get_description(This,actionIndex,description) ) 

#define IAccessibleHyperlink_get_keyBinding(This,actionIndex,nMaxBindings,keyBindings,nBindings)	\
    ( (This)->lpVtbl -> get_keyBinding(This,actionIndex,nMaxBindings,keyBindings,nBindings) ) 

#define IAccessibleHyperlink_get_name(This,actionIndex,name)	\
    ( (This)->lpVtbl -> get_name(This,actionIndex,name) ) 

#define IAccessibleHyperlink_get_localizedName(This,actionIndex,localizedName)	\
    ( (This)->lpVtbl -> get_localizedName(This,actionIndex,localizedName) ) 


#define IAccessibleHyperlink_get_anchor(This,index,anchor)	\
    ( (This)->lpVtbl -> get_anchor(This,index,anchor) ) 

#define IAccessibleHyperlink_get_anchorTarget(This,index,anchorTarget)	\
    ( (This)->lpVtbl -> get_anchorTarget(This,index,anchorTarget) ) 

#define IAccessibleHyperlink_get_startIndex(This,index)	\
    ( (This)->lpVtbl -> get_startIndex(This,index) ) 

#define IAccessibleHyperlink_get_endIndex(This,index)	\
    ( (This)->lpVtbl -> get_endIndex(This,index) ) 

#define IAccessibleHyperlink_get_valid(This,valid)	\
    ( (This)->lpVtbl -> get_valid(This,valid) ) 

#endif /* COBJMACROS */


#endif 	/* C style interface */




#endif 	/* __IAccessibleHyperlink_INTERFACE_DEFINED__ */


/* Additional Prototypes for ALL interfaces */

unsigned long             __RPC_USER  VARIANT_UserSize(     unsigned long *, unsigned long            , VARIANT * ); 
unsigned char * __RPC_USER  VARIANT_UserMarshal(  unsigned long *, unsigned char *, VARIANT * ); 
unsigned char * __RPC_USER  VARIANT_UserUnmarshal(unsigned long *, unsigned char *, VARIANT * ); 
void                      __RPC_USER  VARIANT_UserFree(     unsigned long *, VARIANT * ); 

/* end of Additional Prototypes */

#ifdef __cplusplus
}
#endif

#endif


